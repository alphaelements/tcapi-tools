use thiserror::Error;

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

    #[error("device error: {0}")]
    UnknownDevice(String),

    #[error("connection error: {0}")]
    Connection(#[from] serialport::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("parse error: {0}")]
    Parse(String),

    #[error("timeout waiting for response")]
    Timeout,

    #[error("no device found")]
    NoDevice,

    #[error("multiple devices found (specify --uid, --device, or --port)")]
    MultipleDevices,

    #[error("device disconnected")]
    Disconnected,

    #[error("unsupported firmware: {0} (requires FW Phase 9.6+)")]
    UnsupportedFirmware(String),
}

pub type Result<T> = std::result::Result<T, SdkError>;

impl SdkError {
    pub fn from_error_code(code: &str) -> Self {
        match code {
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
            other => Self::UnknownDevice(other.to_string()),
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
    }

    #[test]
    fn test_from_error_code_unknown() {
        assert!(matches!(
            SdkError::from_error_code("FOOBAR"),
            SdkError::UnknownDevice(_)
        ));
    }
}
