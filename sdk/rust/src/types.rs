use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionInfo {
    pub major: u8,
    pub minor: u8,
    pub patch: u8,
    pub protocol_version: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    pub protocol_version: u8,
    pub max_dio: u8,
    pub out_count: u8,
    pub in_count: u8,
    pub ts_resolution_ns: u32,
    pub max_pattern_steps: u16,
    pub ts_ring_events: u16,
    pub features: u32,
}

impl Capabilities {
    pub fn has_sync(&self) -> bool {
        self.features & 0x01 != 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub uid: String,
    pub device_number: Option<u8>,
    pub port: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IoState {
    pub inputs: u32,
    pub outputs: u32,
    pub flags: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinMap {
    pub version: u8,
    pub out_base: u8,
    pub out_count: u8,
    pub in_base: u8,
    pub in_count: u8,
    pub pull: PullMode,
    pub flags: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullMode {
    None,
    Up,
    Down,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternStep {
    pub out_bits: u32,
    pub hold_us: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatternMode {
    Once,
    Loop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternStatus {
    pub state: PatternState,
    pub current_step: u16,
    pub loops_done: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatternState {
    Idle,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimestampEvent {
    pub inputs: u32,
    pub raw_count: u32,
    pub raw_phase: u8,
    pub sync_active: bool,
    pub timestamp_ns: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimestampResult {
    pub events: Vec<TimestampEvent>,
    pub reconciled: bool,
}

/// Asynchronous push event from the device (`! ...` lines).
///
/// `Unknown` preserves unrecognized event types from newer firmware so they
/// are observable instead of silently dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushEvent {
    InputChange {
        inputs: u32,
        timestamp_us: u64,
    },
    PatternDone {
        loops: u16,
    },
    SyncDone {
        status: String,
        devnum: u8,
        timestamp: u64,
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

    #[test]
    fn test_capabilities_has_sync() {
        let caps = Capabilities {
            protocol_version: 1,
            max_dio: 23,
            out_count: 12,
            in_count: 11,
            ts_resolution_ns: 40,
            max_pattern_steps: 256,
            ts_ring_events: 256,
            features: 0x01,
        };
        assert!(caps.has_sync());
    }

    #[test]
    fn test_capabilities_no_sync() {
        let caps = Capabilities {
            protocol_version: 1,
            max_dio: 23,
            out_count: 0,
            in_count: 23,
            ts_resolution_ns: 40,
            max_pattern_steps: 256,
            ts_ring_events: 256,
            features: 0x00,
        };
        assert!(!caps.has_sync());
    }

    #[test]
    fn test_pattern_step_serialization() {
        let step = PatternStep {
            out_bits: 0x0F,
            hold_us: 100,
        };
        let json = serde_json::to_string(&step).unwrap();
        let deserialized: PatternStep = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.out_bits, 0x0F);
        assert_eq!(deserialized.hold_us, 100);
    }
}
