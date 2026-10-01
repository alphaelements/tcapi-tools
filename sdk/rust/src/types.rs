//! v2 data types and the channel / pin convention (REF-V2 sections 2 and 4.2).
//!
//! Every bit mask on the wire is a **physical GP bit position**. Logical
//! channels `ch0..=ch24` are a host-side display concept only; use
//! [`ch_to_gp`], [`gp_to_ch`], [`pin_label`] and [`VALID_DIO_MASK`] instead of
//! re-deriving bit positions.

use serde::{Deserialize, Serialize};

use crate::error::{Result, SdkError};

/// The only protocol version this SDK speaks (`version` reports `proto=2`).
pub const PROTO_VERSION: u8 = 2;

/// Bit mask of the DIO pins: GP0-GP22, GP26, GP27 (R-P2).
pub const VALID_DIO_MASK: u32 = 0x0c7f_ffff;

/// Number of DIO channels (`ch0..=ch24`).
pub const DIO_CHANNELS: u8 = 25;

/// Pattern tick: one `hold_ticks` unit in nanoseconds.
pub const PATTERN_TICK_NS: u32 = 200;

/// First GP pin that is shifted past the unusable GP23-GP25 (ch23 -> GP26).
const FIRST_RELOCATED_GP: u8 = 26;
/// First channel that is relocated (ch23).
const FIRST_RELOCATED_CH: u8 = 23;

fn invalid(msg: impl Into<String>) -> SdkError {
    SdkError::InvalidArgument(msg.into())
}

/// Physical GP pin of logical channel `ch` (ch0-22 -> GP0-22, ch23 -> GP26,
/// ch24 -> GP27).
pub fn ch_to_gp(ch: u8) -> Result<u8> {
    match ch {
        0..FIRST_RELOCATED_CH => Ok(ch),
        FIRST_RELOCATED_CH..DIO_CHANNELS => Ok(ch - FIRST_RELOCATED_CH + FIRST_RELOCATED_GP),
        _ => Err(invalid(format!(
            "channel ch{ch} is out of range (ch0-ch{})",
            DIO_CHANNELS - 1
        ))),
    }
}

/// Logical channel of physical GP pin `gp`; fails for non-DIO pins
/// (GP23-GP25, GP28 and above).
pub fn gp_to_ch(gp: u8) -> Result<u8> {
    match gp {
        0..FIRST_RELOCATED_CH => Ok(gp),
        FIRST_RELOCATED_GP..=27 => Ok(gp - FIRST_RELOCATED_GP + FIRST_RELOCATED_CH),
        _ => Err(invalid(format!("GP{gp} is not a DIO pin"))),
    }
}

/// Display label for physical GP pin `gp`, e.g. `GP26 (ch23)`.
pub fn pin_label(gp: u8) -> Result<String> {
    Ok(format!("GP{gp} (ch{})", gp_to_ch(gp)?))
}

/// Reject a mask that has bits outside [`VALID_DIO_MASK`] (R-PIN2).
pub fn check_dio_mask(name: &str, mask: u32) -> Result<()> {
    if mask & !VALID_DIO_MASK != 0 {
        return Err(invalid(format!(
            "{name} {mask:#010x} has bits outside the DIO pins ({VALID_DIO_MASK:#010x})"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionInfo {
    pub major: u8,
    pub minor: u8,
    pub patch: u8,
    pub protocol_version: u8,
}

/// `caps` response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    /// Number of DIO pins (25).
    pub dio: u8,
    /// Pins currently configured as outputs.
    pub out: u8,
    /// Pins currently configured as inputs.
    pub r#in: u8,
    /// Timestamp phase resolution in nanoseconds (40).
    pub ts_res_ns: u32,
    /// Pattern tick in nanoseconds (200).
    pub tick_ns: u32,
    /// Maximum number of pattern steps.
    pub pattern_max: u16,
    /// Timestamp ring capacity in events.
    pub ring: u16,
    /// Feature bit mask (`FEAT_*`).
    pub features: u32,
}

/// `caps.features` bit 0: multi-device clock sync (`SYNC_*` commands).
pub const FEAT_SYNC: u32 = 0x01;

/// `caps.features` bit 1: reset commands (`PATTERN_RESET` / `SYSTEM_RESET` /
/// `BOOTSEL_RESET`). Set by FW v0.1.3+.
pub const FEAT_RESET: u32 = 0x02;

impl Capabilities {
    pub fn has_sync(&self) -> bool {
        self.features & FEAT_SYNC != 0
    }

    /// True if the device supports `PATTERN_RESET` / `SYSTEM_RESET` /
    /// `BOOTSEL_RESET` (FW v0.1.3+).
    pub fn has_reset(&self) -> bool {
        self.features & FEAT_RESET != 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub uid: String,
    pub device_number: Option<u8>,
    pub port: String,
    pub version: Option<String>,
}

/// `state` response: input and output levels as physical GP bit masks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IoState {
    pub inputs: u32,
    pub outputs: u32,
}

/// v2 pin map: 32 bytes on the binary protocol, 8 `key=value` fields on the
/// text protocol. All masks are physical GP bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinMap {
    /// Reserved, must be 0 in v2.
    pub flags: u8,
    /// `dir`: 1 = output.
    pub direction: u32,
    /// `pu`: pull-up (inputs only, exclusive with `pull_down`).
    pub pull_up: u32,
    /// `pd`: pull-down (inputs only).
    pub pull_down: u32,
    /// `def`: initial output level (outputs only).
    pub out_default: u32,
    /// `opol`: output polarity inversion (outputs only).
    pub out_polarity: u32,
    /// `ipol`: input polarity inversion (inputs only).
    pub in_polarity: u32,
    /// `edge`: inputs watched for `! INPUT` change events.
    pub edge: u32,
}

impl Default for PinMap {
    /// The device's default map: every pin an input with pull-down and edge
    /// events enabled (R-M4).
    fn default() -> Self {
        Self {
            flags: 0,
            direction: 0,
            pull_up: 0,
            pull_down: VALID_DIO_MASK,
            out_default: 0,
            out_polarity: 0,
            in_polarity: 0,
            edge: VALID_DIO_MASK,
        }
    }
}

impl PinMap {
    /// Check every R-M1 rule; the error names the offending field.
    pub fn validate(&self) -> Result<()> {
        let outputs = self.direction;
        let inputs = VALID_DIO_MASK & !self.direction;
        if self.flags != 0 {
            return Err(invalid(format!(
                "flags {:#04x}: all bits are reserved and must be 0",
                self.flags
            )));
        }
        if self.direction & !VALID_DIO_MASK != 0 {
            return Err(invalid(format!(
                "direction {:#010x} has bits outside the DIO pins",
                self.direction
            )));
        }
        let subset = |name: &str, value: u32, allowed: u32, what: &str| -> Result<()> {
            if value & !allowed != 0 {
                return Err(invalid(format!(
                    "{name} {value:#010x} has bits that are not {what}"
                )));
            }
            Ok(())
        };
        subset("pull_up", self.pull_up, inputs, "DIO input pins")?;
        subset("pull_down", self.pull_down, inputs, "DIO input pins")?;
        if self.pull_up & self.pull_down != 0 {
            return Err(invalid(format!(
                "pull_up & pull_down {:#010x}: a pin cannot have both pulls",
                self.pull_up & self.pull_down
            )));
        }
        subset("out_default", self.out_default, outputs, "output pins")?;
        subset("out_polarity", self.out_polarity, outputs, "output pins")?;
        subset("in_polarity", self.in_polarity, inputs, "DIO input pins")?;
        subset("edge", self.edge, inputs, "DIO input pins")?;
        Ok(())
    }

    /// Arguments for `map set`, which equal the payload of a `map get`
    /// response (R-M3). Refuses to encode an invalid map.
    pub fn to_set_args(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "v={PROTO_VERSION} flags={:#04x} dir={:#010x} pu={:#010x} pd={:#010x} \
             def={:#010x} opol={:#010x} ipol={:#010x} edge={:#010x}",
            self.flags,
            self.direction,
            self.pull_up,
            self.pull_down,
            self.out_default,
            self.out_polarity,
            self.in_polarity,
            self.edge
        ))
    }

    /// Parse the data of a `map get` response (`v=2 flags=... edge=...`).
    /// The map is validated, so an invalid device response is an error.
    pub fn parse_get(data: &str) -> Result<Self> {
        crate::protocol::parse_map(data)
    }
}

/// One pattern step: output levels held for `hold_ticks` pattern ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatternStep {
    /// Logical output value (physical GP bits, subset of the direction mask).
    pub out_bits: u32,
    /// Hold time in pattern ticks of [`PATTERN_TICK_NS`] ns; at least 1.
    pub hold_ticks: u32,
}

impl PatternStep {
    /// Check host-side limits: DIO bits only, non-zero hold.
    pub fn validate(&self) -> Result<()> {
        check_dio_mask("out_bits", self.out_bits)?;
        if self.hold_ticks == 0 {
            return Err(invalid("hold_ticks must be at least 1"));
        }
        Ok(())
    }

    /// Text form for `pattern add`: `<out_bits>:<hold_ticks>`, e.g. `0x1:5`.
    pub fn to_text(&self) -> Result<String> {
        self.validate()?;
        Ok(format!("{:#x}:{}", self.out_bits, self.hold_ticks))
    }

    /// Hold time in nanoseconds (the tick part only; the fixed ~133 ns PIO
    /// overhead of each step is not included, R-PT5).
    pub fn hold_ns(&self) -> u64 {
        u64::from(self.hold_ticks) * u64::from(PATTERN_TICK_NS)
    }
}

/// Convert a hold time in nanoseconds to pattern ticks. Only exact multiples
/// of [`PATTERN_TICK_NS`] are accepted (never rounded); the result must be
/// between 1 and `u32::MAX` ticks.
pub fn hold_ticks_from_ns(ns: u64) -> Result<u32> {
    let tick = u64::from(PATTERN_TICK_NS);
    if !ns.is_multiple_of(tick) {
        return Err(invalid(format!(
            "{ns} ns is not a multiple of the {PATTERN_TICK_NS} ns pattern tick"
        )));
    }
    let ticks = ns / tick;
    if ticks == 0 {
        return Err(invalid("hold time must be at least one tick"));
    }
    u32::try_from(ticks).map_err(|_| invalid(format!("{ns} ns exceeds the u32 tick range")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatternMode {
    Once,
    Loop,
}

/// `pattern status` response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatternStatus {
    pub state: PatternState,
    /// Current step while running.
    pub step: u16,
    /// Completed loop count.
    pub loops: u16,
    /// Number of steps in the pattern buffer.
    pub total: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatternState {
    Idle,
    /// Pattern data loaded but not started (FW state 1).
    Loaded,
    Running,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeMode {
    Rising,
    Falling,
    Both,
}

/// `ts status` response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TsStatus {
    pub armed: bool,
    /// Events waiting in the device ring.
    pub pending: u32,
    /// The ring overflowed since the last `ts get`.
    pub overflow: bool,
}

/// One captured edge: `in=<inputs> c=<count> p=<phase> s=<sync>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimestampEvent {
    /// Logical input values within the armed mask (polarity applied).
    pub inputs: u32,
    pub raw_count: u32,
    pub raw_phase: u8,
    pub sync_active: bool,
}

impl TimestampEvent {
    /// Nanosecond timestamp (R-TS1): with sync active `count * 1000 +
    /// phase * ts_res_ns`; free running, `count` is TIMER0 microseconds and
    /// the phase is always 0.
    pub fn ns(&self, ts_res_ns: u32) -> i64 {
        let base = i64::from(self.raw_count) * 1000;
        if self.sync_active {
            base + i64::from(self.raw_phase) * i64::from(ts_res_ns)
        } else {
            base
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimestampResult {
    pub events: Vec<TimestampEvent>,
    pub reconciled: bool,
    /// `true` if the FW reported a ring overflow since the last `ts get`
    /// (i.e. events were dropped).
    #[serde(default)]
    pub overflow: bool,
}

/// Asynchronous push event from the device (`! ...` lines).
///
/// `Unknown` preserves unrecognized event types so they are observable
/// instead of silently dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushEvent {
    /// `! INPUT in=0x%08x t=<u64 us>`: logical input word and detection time.
    InputChange {
        inputs: u32,
        t_us: u64,
    },
    PatternDone {
        loops: u16,
    },
    /// Pattern aborted by the FW wall-clock safety budget (FW v0.1.3+). The
    /// SM / DMA are forced to a safe state; outputs hold the last written
    /// step value until the host issues `write` or `pattern reset`.
    PatternTimeout {
        loops: u16,
    },
    Unknown {
        raw: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncRole {
    Master,
    Slave,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    Idle,
    Armed,
    MasterArmed,
    Clocking,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps_with_features(features: u32) -> Capabilities {
        Capabilities {
            dio: 25,
            out: 12,
            r#in: 13,
            ts_res_ns: 40,
            tick_ns: 200,
            pattern_max: 256,
            ring: 256,
            features,
        }
    }

    #[test]
    fn test_capabilities_has_sync() {
        assert!(caps_with_features(FEAT_SYNC).has_sync());
        assert!(caps_with_features(FEAT_SYNC | FEAT_RESET).has_sync());
    }

    #[test]
    fn test_capabilities_no_sync() {
        assert!(!caps_with_features(0).has_sync());
        assert!(!caps_with_features(FEAT_RESET).has_sync());
    }

    #[test]
    fn test_capabilities_has_reset() {
        assert!(caps_with_features(FEAT_RESET).has_reset());
        assert!(caps_with_features(FEAT_SYNC | FEAT_RESET).has_reset());
    }

    #[test]
    fn test_capabilities_no_reset() {
        assert!(!caps_with_features(0).has_reset());
        assert!(!caps_with_features(FEAT_SYNC).has_reset());
    }

    #[test]
    fn test_feature_constants() {
        assert_eq!(FEAT_SYNC, 0x1);
        assert_eq!(FEAT_RESET, 0x2);
    }

    #[test]
    fn test_capabilities_serializes_in_as_plain_key() {
        let json = serde_json::to_value(caps_with_features(0)).unwrap();
        assert_eq!(json["in"], 13);
        assert_eq!(json["pattern_max"], 256);
    }

    #[test]
    fn test_pattern_step_serialization() {
        let step = PatternStep {
            out_bits: 0x0F,
            hold_ticks: 100,
        };
        let json = serde_json::to_string(&step).unwrap();
        let deserialized: PatternStep = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, step);
    }

    #[test]
    fn test_push_event_input_change_serialization() {
        let json = serde_json::to_value(PushEvent::InputChange { inputs: 1, t_us: 7 }).unwrap();
        assert_eq!(json["type"], "input_change");
        assert_eq!(json["t_us"], 7);
    }
}
