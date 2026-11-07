//! v2 data types and the channel / pin convention (REF-V2 sections 2 and 4.2).
//!
//! Every bit mask on the wire is a **physical GP bit position**. Logical
//! channels `ch0..=ch24` are a host-side display concept only; use
//! [`ch_to_gp`], [`gp_to_ch`], [`pin_label`] and [`VALID_DIO_MASK`] instead of
//! re-deriving bit positions.

use serde::{Deserialize, Serialize};

use crate::error::{Result, SdkError};
use crate::protocol;

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

/// `caps.features` bit 2: `wdog`, `safety`, `failsafe clear`, `! FAILSAFE`.
pub const FEAT_WDOG: u32 = 0x04;

/// `caps.features` bit 3: `excl` (exclusive output groups).
pub const FEAT_EXCL: u32 = 0x08;

/// `caps.features` bit 4: `outputs reset`.
pub const FEAT_OUTRESET: u32 = 0x10;

/// `caps.features` bit 5: `rstinfo`.
pub const FEAT_RSTINFO: u32 = 0x20;

/// `caps.features` bit 6: `usbsafe`.
pub const FEAT_USBSAFE: u32 = 0x40;

/// `caps.features` bit 7: `pads`.
pub const FEAT_PADS: u32 = 0x80;

/// One feature bit of `caps feat=` (protocol-reference.md section 4,
/// `caps`). A host sends a command only when its bit is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    /// Bit 0: multi-device clock sync.
    Sync,
    /// Bit 1: reset commands.
    Reset,
    /// Bit 2: watchdog, `safety`, failsafe latch.
    Wdog,
    /// Bit 3: exclusive output groups.
    Excl,
    /// Bit 4: `outputs reset`.
    OutReset,
    /// Bit 5: `rstinfo`.
    RstInfo,
    /// Bit 6: `usbsafe`.
    UsbSafe,
    /// Bit 7: `pads`.
    Pads,
}

impl Feature {
    /// Every defined feature, in bit order (bit 0 first).
    pub const ALL: [Feature; 8] = [
        Feature::Sync,
        Feature::Reset,
        Feature::Wdog,
        Feature::Excl,
        Feature::OutReset,
        Feature::RstInfo,
        Feature::UsbSafe,
        Feature::Pads,
    ];

    /// The mask of all defined feature bits (bits 0-7).
    pub const MASK: u32 = 0xff;

    /// The `caps.features` bit of this feature.
    pub const fn bit(self) -> u32 {
        match self {
            Feature::Sync => FEAT_SYNC,
            Feature::Reset => FEAT_RESET,
            Feature::Wdog => FEAT_WDOG,
            Feature::Excl => FEAT_EXCL,
            Feature::OutReset => FEAT_OUTRESET,
            Feature::RstInfo => FEAT_RSTINFO,
            Feature::UsbSafe => FEAT_USBSAFE,
            Feature::Pads => FEAT_PADS,
        }
    }
}

impl Capabilities {
    pub fn has_sync(&self) -> bool {
        self.has(Feature::Sync)
    }

    /// True if the device supports `PATTERN_RESET` / `SYSTEM_RESET` /
    /// `BOOTSEL_RESET` (FW v0.1.3+).
    pub fn has_reset(&self) -> bool {
        self.has(Feature::Reset)
    }

    /// True if the feature bit is set in `features`.
    pub fn has(&self, feature: Feature) -> bool {
        self.features & feature.bit() != 0
    }

    /// The defined features whose bit is set, in bit order.
    pub fn feature_list(&self) -> Vec<Feature> {
        Feature::ALL.into_iter().filter(|f| self.has(*f)).collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub uid: String,
    pub device_number: Option<u8>,
    pub port: String,
    pub version: Option<String>,
}

/// Smallest enabled watchdog timeout in milliseconds (`wdog <ms>`).
pub const WDOG_MIN_MS: u32 = 100;

/// Largest watchdog timeout in milliseconds.
pub const WDOG_MAX_MS: u32 = 10_000;

/// Most exclusive groups the device holds (`excl set`).
pub const MAX_EXCLUSIVE_GROUPS: usize = 16;

/// Why the failsafe latch is set (`safety cause=`, `! FAILSAFE cause=`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FailsafeCause {
    /// The latch is not set.
    None,
    /// The watchdog tripped.
    Wdog,
    /// The USB link was lost with `usbsafe on`.
    Usb,
}

impl FailsafeCause {
    /// The wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            FailsafeCause::None => "none",
            FailsafeCause::Wdog => "wdog",
            FailsafeCause::Usb => "usb",
        }
    }

    /// Parse the wire spelling (exact, lower case).
    pub fn from_name(name: &str) -> Option<Self> {
        [Self::None, Self::Wdog, Self::Usb]
            .into_iter()
            .find(|c| c.as_str() == name)
    }
}

/// The declared safety settings of a `safety.toml`: what the device must
/// look like after `apply_safety`. The all-off default is the content of a
/// file with only `version = 2`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SafetyConfig {
    /// `watchdog.timeout_ms`: `0` = disabled, otherwise `100..=10000`.
    pub watchdog_ms: u32,
    /// `usb.safe`: `usbsafe on` when true.
    pub usbsafe: bool,
    /// One pin mask per `[[exclusive]]`, in file order (at most 16, each a
    /// subset of [`VALID_DIO_MASK`] with at least 2 bits).
    pub groups: Vec<u32>,
}

impl SafetyConfig {
    /// The commands that make the device equal to this configuration, in the
    /// DD-16 order (config-files.md section 7): `excl set <masks>` (or
    /// `excl clear` when there are no groups), `usbsafe on|off`, `wdog <ms>`.
    ///
    /// `excl set` replaces all groups atomically, so `excl clear` is sent
    /// only when there are no groups and never before an `excl set`. The
    /// watchdog goes last so it cannot trip while the rest is still being
    /// sent. A value the device would refuse is an
    /// [`SdkError::InvalidArgument`] and nothing is produced.
    pub fn commands(&self) -> Result<Vec<String>> {
        let excl = if self.groups.is_empty() {
            "excl clear".to_string()
        } else {
            protocol::excl_set_command(&self.groups)?
        };
        Ok(vec![
            excl,
            protocol::usbsafe_command(self.usbsafe),
            protocol::wdog_command(self.watchdog_ms)?,
        ])
    }
}

/// `safety` response: the volatile safety state of the device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafetyState {
    /// Configured watchdog timeout in milliseconds, `0` = disabled.
    pub wdog_ms: u32,
    /// Time left, rounded up, read before this command restarted the timer;
    /// `0` when disabled or latched.
    pub remaining_ms: u32,
    /// The failsafe latch.
    pub failsafe: bool,
    /// The cause of the latch (the first cause is kept); `None` when clear.
    pub cause: FailsafeCause,
    /// The `usbsafe` setting.
    pub usbsafe: bool,
    /// Number of exclusive groups (0-16).
    pub excl: u8,
}

/// Cause of the last restart (`rstinfo cause=`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResetCause {
    /// Power-on.
    Por,
    /// Hardware watchdog.
    Wdt,
    /// Software reset (including the `reset` command).
    Soft,
    /// Brown-out.
    Bor,
    /// Anything else.
    Other,
}

impl ResetCause {
    /// The wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            ResetCause::Por => "por",
            ResetCause::Wdt => "wdt",
            ResetCause::Soft => "soft",
            ResetCause::Bor => "bor",
            ResetCause::Other => "other",
        }
    }

    /// Parse the wire spelling (exact, lower case).
    pub fn from_name(name: &str) -> Option<Self> {
        [Self::Por, Self::Wdt, Self::Soft, Self::Bor, Self::Other]
            .into_iter()
            .find(|c| c.as_str() == name)
    }
}

/// `rstinfo` response: the cause and time of the last restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResetInfo {
    pub cause: ResetCause,
    /// Milliseconds since the restart.
    pub uptime_ms: u64,
    /// A value that differs at every restart; a changed value tells the host
    /// the device restarted and its safety settings must be re-applied.
    pub boot: u32,
}

/// `pads` response: the recorded outputs and the level read back from the
/// pads of the output pins, both logical. A difference means something
/// outside the device drives the pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pads {
    pub out: u32,
    pub pad: u32,
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
    /// `! FAILSAFE cause=<wdog|usb>`: the failsafe latch was set (FW with
    /// [`FEAT_WDOG`]). Events can be missed; `safety` is the source of truth.
    /// `cause` is never [`FailsafeCause::None`].
    Failsafe {
        cause: FailsafeCause,
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

    #[test]
    fn feature_bits_are_the_protocol_bits() {
        let bits: Vec<(Feature, u32)> = Feature::ALL.iter().map(|f| (*f, f.bit())).collect();
        assert_eq!(
            bits,
            [
                (Feature::Sync, 0x01),
                (Feature::Reset, 0x02),
                (Feature::Wdog, 0x04),
                (Feature::Excl, 0x08),
                (Feature::OutReset, 0x10),
                (Feature::RstInfo, 0x20),
                (Feature::UsbSafe, 0x40),
                (Feature::Pads, 0x80),
            ]
        );
        assert_eq!(Feature::MASK, 0xff);
        assert_eq!(FEAT_WDOG, 0x04);
        assert_eq!(FEAT_PADS, 0x80);
    }

    #[test]
    fn capabilities_has_tests_each_feature_bit() {
        let caps = caps_with_features(FEAT_WDOG | FEAT_PADS);
        assert!(caps.has(Feature::Wdog) && caps.has(Feature::Pads));
        for f in [
            Feature::Sync,
            Feature::Reset,
            Feature::Excl,
            Feature::OutReset,
            Feature::RstInfo,
            Feature::UsbSafe,
        ] {
            assert!(!caps.has(f), "{f:?}");
        }
        assert_eq!(caps.feature_list(), [Feature::Wdog, Feature::Pads]);
        assert_eq!(caps_with_features(0xff).feature_list(), Feature::ALL);
        assert!(caps_with_features(0).feature_list().is_empty());
    }

    #[test]
    fn failsafe_cause_names_round_trip() {
        for (cause, name) in [
            (FailsafeCause::None, "none"),
            (FailsafeCause::Wdog, "wdog"),
            (FailsafeCause::Usb, "usb"),
        ] {
            assert_eq!(cause.as_str(), name);
            assert_eq!(FailsafeCause::from_name(name), Some(cause));
        }
        assert_eq!(FailsafeCause::from_name("WDOG"), None);
        assert_eq!(FailsafeCause::from_name(""), None);
    }

    #[test]
    fn reset_cause_names_round_trip() {
        for (cause, name) in [
            (ResetCause::Por, "por"),
            (ResetCause::Wdt, "wdt"),
            (ResetCause::Soft, "soft"),
            (ResetCause::Bor, "bor"),
            (ResetCause::Other, "other"),
        ] {
            assert_eq!(cause.as_str(), name);
            assert_eq!(ResetCause::from_name(name), Some(cause));
        }
        assert_eq!(ResetCause::from_name("reset"), None);
    }

    #[test]
    fn push_event_failsafe_serialization() {
        let json = serde_json::to_value(PushEvent::Failsafe {
            cause: FailsafeCause::Wdog,
        })
        .unwrap();
        assert_eq!(json["type"], "failsafe");
        assert_eq!(json["cause"], "wdog");
    }

    #[test]
    fn safety_config_commands_follow_dd16_order() {
        let cfg = SafetyConfig {
            watchdog_ms: 800,
            usbsafe: true,
            groups: vec![0xc, 0x18],
        };
        assert_eq!(
            cfg.commands().unwrap(),
            ["excl set 0xc 0x18", "usbsafe on", "wdog 800"]
        );
    }

    #[test]
    fn safety_config_without_groups_sends_excl_clear_first() {
        assert_eq!(
            SafetyConfig::default().commands().unwrap(),
            ["excl clear", "usbsafe off", "wdog 0"]
        );
    }

    #[test]
    fn safety_config_never_sends_excl_clear_before_excl_set() {
        let cfg = SafetyConfig {
            groups: vec![0x3],
            ..SafetyConfig::default()
        };
        let cmds = cfg.commands().unwrap();
        assert!(!cmds.iter().any(|c| c == "excl clear"), "{cmds:?}");
        assert_eq!(cmds[0], "excl set 0x3");
    }

    #[test]
    fn safety_config_refuses_values_the_device_would_refuse() {
        for cfg in [
            SafetyConfig {
                watchdog_ms: 99,
                ..SafetyConfig::default()
            },
            SafetyConfig {
                watchdog_ms: 10_001,
                ..SafetyConfig::default()
            },
            SafetyConfig {
                groups: vec![0x1],
                ..SafetyConfig::default()
            },
            SafetyConfig {
                groups: vec![0x3; 17],
                ..SafetyConfig::default()
            },
        ] {
            assert!(
                matches!(cfg.commands(), Err(SdkError::InvalidArgument(_))),
                "{cfg:?}"
            );
        }
    }
}
