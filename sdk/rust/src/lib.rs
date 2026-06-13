//! Rust SDK for Pochi-DIO — RP2350-based high-speed digital I/O unit.
//!
//! Talks the USB CDC **text command mode** (`{cmd}\r\n` → `OK ...` /
//! `ERR ...`, push lines `! ...`). Requires firmware Phase 9.6+; older
//! firmware (pre-raw-timestamp format) is rejected explicitly.
//!
//! # Quick start
//!
//! ```no_run
//! use pochi_sdk::{discover, Connection};
//!
//! let devices = discover()?;
//! let mut conn = Connection::open(&devices[0].port)?;
//! let caps = conn.caps()?;
//! conn.write(0x05, 0x0F)?;
//! let inputs = conn.read()?;
//! # Ok::<(), pochi_sdk::SdkError>(())
//! ```

pub mod connection;
pub mod discovery;
pub mod error;
pub mod protocol;
pub mod reconcile;
pub mod toml_config;
pub mod transport;
pub mod types;

pub use connection::Connection;
pub use discovery::{discover, discover_detailed, enumerate_ports, Discovery, ProbeFailure};
pub use error::{Result, SdkError};
pub use transport::{TrafficDirection, TrafficHook};
pub use types::{
    Capabilities, DeviceInfo, EdgeMode, IoState, PatternMode, PatternState, PatternStatus,
    PatternStep, PinMap, PullMode, PushEvent, SyncRole, SyncState, TimestampEvent, TimestampResult,
    VersionInfo, FEAT_RESET, FEAT_SYNC,
};
