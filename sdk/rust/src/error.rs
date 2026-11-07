use thiserror::Error;

use crate::protocol;

#[derive(Debug, Error)]
pub enum SdkError {
    #[error("device error: BAD_CMD (unknown command)")]
    BadCommand,

    #[error("device error: BAD_PARAM (invalid parameter)")]
    BadParam,

    #[error("device error: BAD_MAP (map validation failed)")]
    BadMap,

    #[error("device error: BUSY (device is busy)")]
    Busy,

    #[error("device error: FLASH (flash write/read failed)")]
    Flash,

    #[error("device error: TOO_LONG (payload too long)")]
    TooLong,

    #[error("device error: NOT_ARMED (timestamp not armed)")]
    NotArmed,

    #[error("device error: SYNC_STATE (invalid sync state transition)")]
    SyncState,

    #[error("device error: SYNC_TIMEOUT (sync pulse not detected)")]
    SyncTimeout,

    #[error("device error: NO_RESOURCE (required resource not configured)")]
    NoResource,

    #[error("device error: NOT_RUNNING (pattern not running)")]
    NotRunning,

    /// `ERR FAILSAFE`: the failsafe latch is set and the command would move
    /// an output away from its `def`. Check `safety`, then `failsafe clear`.
    #[error("device error: FAILSAFE (failsafe latch is set)")]
    Failsafe,

    /// `ERR EXCLUSIVE group=<i> mask=0x%08x`: the instruction would put two
    /// or more pins of an exclusive group ON.
    #[error(
        "device error: EXCLUSIVE (exclusive group {group} would be violated, mask {mask:#010x})"
    )]
    Exclusive {
        /// 0-based index of the first violating group.
        group: u8,
        /// The pin mask of that group.
        mask: u32,
    },

    /// `ERR TRANSPORT_NOT_SUPPORTED`: the command is CDC only (a text host
    /// never sees it).
    #[error("device error: TRANSPORT_NOT_SUPPORTED (command is not available on this transport)")]
    TransportNotSupported,

    #[error("device error: {0}")]
    UnknownDevice(String),

    /// The state read back after `apply_safety` differs from the settings
    /// that were applied.
    #[error("safety read-back differs from the applied settings: {0}")]
    SafetyMismatch(String),

    #[error("connection error: {0}")]
    Connection(#[from] serialport::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("parse error: {0}")]
    Parse(String),

    /// A value was rejected by host-side validation before anything was sent.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("timeout waiting for response")]
    Timeout,

    #[error("no device found")]
    NoDevice,

    #[error("multiple devices found (specify --uid, --device, or --port)")]
    MultipleDevices,

    #[error("device disconnected")]
    Disconnected,

    #[error("unsupported firmware: {0}")]
    UnsupportedFirmware(String),
}

pub type Result<T> = std::result::Result<T, SdkError>;

impl SdkError {
    /// Map the text after `ERR ` to a typed error.
    ///
    /// The first whitespace-separated token is the error name; any further
    /// tokens are `key=value` data and never make the line unparseable
    /// (protocol-reference.md section 3). `EXCLUSIVE` reads `group=` and
    /// `mask=` from them; an `EXCLUSIVE` line without both is a protocol
    /// violation and becomes [`SdkError::Parse`]. For other known names the
    /// data tokens are ignored; an unknown name keeps the whole text.
    pub fn from_error_code(code: &str) -> Self {
        let mut tokens = code.split_whitespace();
        let name = tokens.next().unwrap_or_default();
        match name {
            "BAD_CMD" | "UNKNOWN_CMD" => Self::BadCommand,
            "BAD_PARAM" => Self::BadParam,
            "BAD_MAP" => Self::BadMap,
            "BUSY" => Self::Busy,
            "FLASH" => Self::Flash,
            "TOO_LONG" | "LINE_TOO_LONG" => Self::TooLong,
            "NOT_ARMED" => Self::NotArmed,
            "SYNC_STATE" => Self::SyncState,
            "SYNC_TIMEOUT" => Self::SyncTimeout,
            "NO_RESOURCE" => Self::NoResource,
            "NOT_RUNNING" => Self::NotRunning,
            "FAILSAFE" => Self::Failsafe,
            "TRANSPORT_NOT_SUPPORTED" => Self::TransportNotSupported,
            "EXCLUSIVE" => Self::exclusive(code, tokens),
            _ => Self::UnknownDevice(code.to_string()),
        }
    }

    fn exclusive<'a>(code: &str, data: impl Iterator<Item = &'a str>) -> Self {
        let mut group = None;
        let mut mask = None;
        for token in data {
            match token.split_once('=') {
                Some(("group", v)) if group.is_none() => {
                    group = v
                        .bytes()
                        .all(|b| b.is_ascii_digit())
                        .then(|| v.parse::<u8>().ok())
                        .flatten();
                }
                Some(("mask", v)) if mask.is_none() => {
                    mask = protocol::parse_u32_hex_or_dec(v).ok();
                }
                _ => {}
            }
        }
        match (group, mask) {
            (Some(group), Some(mask)) => Self::Exclusive { group, mask },
            _ => Self::Parse(format!(
                "malformed ERR EXCLUSIVE (expected group=<i> mask=0x%08x): ERR {code}"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_from_error_code_known() {
        assert!(matches!(
            SdkError::from_error_code("BAD_CMD"),
            SdkError::BadCommand
        ));
        assert!(matches!(SdkError::from_error_code("BUSY"), SdkError::Busy));
        assert!(matches!(
            SdkError::from_error_code("SYNC_TIMEOUT"),
            SdkError::SyncTimeout
        ));
        assert!(matches!(
            SdkError::from_error_code("NOT_RUNNING"),
            SdkError::NotRunning
        ));
    }

    #[test]
    fn test_from_error_code_unknown() {
        assert!(matches!(
            SdkError::from_error_code("FOOBAR"),
            SdkError::UnknownDevice(_)
        ));
    }

    #[test]
    fn failsafe_and_transport_codes_are_typed() {
        assert!(matches!(
            SdkError::from_error_code("FAILSAFE"),
            SdkError::Failsafe
        ));
        assert!(matches!(
            SdkError::from_error_code("TRANSPORT_NOT_SUPPORTED"),
            SdkError::TransportNotSupported
        ));
    }

    #[test]
    fn exclusive_carries_group_and_mask() {
        match SdkError::from_error_code("EXCLUSIVE group=1 mask=0x0000000c") {
            SdkError::Exclusive { group, mask } => assert_eq!((group, mask), (1, 0xc)),
            other => panic!("{other:?}"),
        }
        // Token order is free; further key=value tokens are tolerated.
        match SdkError::from_error_code("EXCLUSIVE mask=0x7 extra=zz group=15 more=1") {
            SdkError::Exclusive { group, mask } => assert_eq!((group, mask), (15, 7)),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            SdkError::from_error_code("EXCLUSIVE group=0 mask=0x0000000c").to_string(),
            "device error: EXCLUSIVE (exclusive group 0 would be violated, mask 0x0000000c)"
        );
    }

    #[test]
    fn exclusive_without_valid_data_is_a_parse_error_not_a_default() {
        for bad in [
            "EXCLUSIVE",
            "EXCLUSIVE group=0",
            "EXCLUSIVE mask=0x3",
            "EXCLUSIVE group=x mask=0x3",
            "EXCLUSIVE group=256 mask=0x3",
            "EXCLUSIVE group=-1 mask=0x3",
            "EXCLUSIVE group=0 mask=zz",
            "EXCLUSIVE group=0 mask=0x100000000",
        ] {
            assert!(
                matches!(SdkError::from_error_code(bad), SdkError::Parse(_)),
                "{bad}"
            );
        }
    }

    #[test]
    fn data_tokens_after_a_plain_name_are_ignored() {
        assert!(matches!(
            SdkError::from_error_code("BUSY detail=1"),
            SdkError::Busy
        ));
        assert!(matches!(
            SdkError::from_error_code("FAILSAFE cause=wdog"),
            SdkError::Failsafe
        ));
    }

    #[test]
    fn unknown_names_keep_the_whole_text() {
        match SdkError::from_error_code("NEW_ERR a=1") {
            SdkError::UnknownDevice(t) => assert_eq!(t, "NEW_ERR a=1"),
            other => panic!("{other:?}"),
        }
    }
}
