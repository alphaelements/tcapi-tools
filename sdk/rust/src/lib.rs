//! Rust SDK for Tcapi-DIO — RP2350-based high-speed digital I/O unit.
//!
//! Talks the USB CDC **text command mode** (`{cmd}\r\n` → `OK ...` /
//! `ERR ...`, push lines `! ...`). Speaks protocol v2 only (`proto=2`); there is no
//! compatibility with older firmware.
//!
//! # Quick start
//!
//! ```no_run
//! use tcapi_sdk::{discover, Connection};
//!
//! let devices = discover()?;
//! let mut conn = Connection::open(&devices[0].port)?;
//! let caps = conn.caps()?;
//! conn.write(0x05, 0x0F)?;
//! let inputs = conn.read()?;
//! # Ok::<(), tcapi_sdk::SdkError>(())
//! ```

pub mod config;
pub mod connection;
pub mod discovery;
pub mod error;
pub mod heartbeat;
pub mod protocol;
pub mod reconcile;
pub mod transport;
pub mod types;

#[cfg(test)]
mod golden_api;
#[cfg(test)]
mod testutil;

pub use connection::Connection;
pub use discovery::{discover, discover_detailed, enumerate_ports, Discovery, ProbeFailure};
pub use error::{Result, SdkError};
pub use heartbeat::{heartbeat_period, Heartbeat};
pub use protocol::TS_GET_MAX;
pub use transport::{TrafficDirection, TrafficHook};
pub use types::{
    ch_to_gp, check_dio_mask, gp_to_ch, hold_ticks_from_ns, pin_label, Capabilities, DeviceInfo,
    EdgeMode, FailsafeCause, Feature, IoState, Pads, PatternMode, PatternState, PatternStatus,
    PatternStep, PinMap, PushEvent, ResetCause, ResetInfo, SafetyConfig, SafetyState, SyncRole,
    SyncState, TimestampEvent, TimestampResult, TsStatus, VersionInfo, DIO_CHANNELS, FEAT_EXCL,
    FEAT_OUTRESET, FEAT_PADS, FEAT_RESET, FEAT_RSTINFO, FEAT_SYNC, FEAT_USBSAFE, FEAT_WDOG,
    MAX_EXCLUSIVE_GROUPS, PATTERN_TICK_NS, PROTO_VERSION, VALID_DIO_MASK, WDOG_MAX_MS, WDOG_MIN_MS,
};
