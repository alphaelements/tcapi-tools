//! Rust SDK for Pochi-DIO — RP2350-based high-speed digital I/O unit.
//!
//! Talks the USB CDC **text command mode** (`{cmd}\r\n` → `OK ...` /
//! `ERR ...`, push lines `! ...`). Speaks protocol v2 only (`proto=2`); there is no
//! compatibility with older firmware.
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
pub mod transport;
pub mod types;

#[cfg(test)]
mod testutil;

pub use connection::Connection;
pub use discovery::{discover, discover_detailed, enumerate_ports, Discovery, ProbeFailure};
pub use error::{Result, SdkError};
pub use transport::{TrafficDirection, TrafficHook};
pub use types::{
    ch_to_gp, check_dio_mask, gp_to_ch, hold_ticks_from_ns, pin_label, Capabilities, DeviceInfo,
    EdgeMode, IoState, PatternMode, PatternState, PatternStatus, PatternStep, PinMap, PushEvent,
    SyncRole, SyncState, TimestampEvent, TimestampResult, TsStatus, VersionInfo, DIO_CHANNELS,
    FEAT_RESET, FEAT_SYNC, PATTERN_TICK_NS, PROTO_VERSION, VALID_DIO_MASK,
};
