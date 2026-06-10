//! High-level typed connection to one Pochi-DIO device.

use std::sync::mpsc::Receiver;
use std::time::Duration;

use crate::discovery;
use crate::error::Result;
use crate::protocol;
use crate::transport::Transport;
use crate::types::{
    Capabilities, DeviceInfo, EdgeMode, IoState, PatternMode, PatternStatus, PatternStep, PinMap,
    PushEvent, TimestampResult, VersionInfo,
};

/// An open connection to a Pochi-DIO device.
///
/// The connection closes when dropped; [`Connection::close`] exists for
/// explicit, eager shutdown.
pub struct Connection {
    transport: Transport,
    port_path: String,
}

impl Connection {
    /// Open a connection to the device at the given serial port path.
    pub fn open(port: &str) -> Result<Self> {
        Ok(Self {
            transport: Transport::open(port)?,
            port_path: port.to_string(),
        })
    }

    /// Discover devices and connect to the one with the given UID
    /// (case-insensitive).
    pub fn open_by_uid(uid: &str) -> Result<Self> {
        let devices = discovery::discover()?;
        let device = discovery::find_by_uid(&devices, uid)?;
        Self::open(&device.port)
    }

    /// Discover devices and connect to the one with the given device number.
    pub fn open_by_device_number(n: u8) -> Result<Self> {
        let devices = discovery::discover()?;
        let device = discovery::find_by_device_number(&devices, n)?;
        Self::open(&device.port)
    }

    /// Discover devices and connect to the sole connected device.
    /// Errors with `NoDevice` / `MultipleDevices` otherwise.
    pub fn open_sole_device() -> Result<Self> {
        let devices = discovery::discover()?;
        let device = discovery::select_sole_device(&devices)?;
        Self::open(&device.port)
    }

    /// Wrap an already-open serial port (PTY tests, custom transports).
    pub fn from_port(port: Box<dyn serialport::SerialPort>) -> Result<Self> {
        Ok(Self {
            transport: Transport::from_port(port)?,
            port_path: String::new(),
        })
    }

    /// Set the command response timeout (default 2 s).
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.transport.set_timeout(timeout);
    }

    // --- device information ---

    /// `version` — firmware and protocol version.
    pub fn version(&mut self) -> Result<VersionInfo> {
        let data = self.transport.command("version")?;
        protocol::parse_version(&data)
    }

    /// `caps` — device capabilities. The protocol version is filled in
    /// from `version` so the struct is complete.
    ///
    /// Fails with `UnsupportedFirmware` on pre-Phase 9.6 firmware
    /// (`ts_res=1000`).
    pub fn caps(&mut self) -> Result<Capabilities> {
        let data = self.transport.command("caps")?;
        let mut caps = protocol::parse_caps(&data)?;
        caps.protocol_version = self.version()?.protocol_version;
        Ok(caps)
    }

    /// `info` — device identification (UID, device number).
    pub fn info(&mut self) -> Result<DeviceInfo> {
        let data = self.transport.command("info")?;
        let (uid, device_number) = protocol::parse_info(&data)?;
        Ok(DeviceInfo {
            uid,
            device_number,
            port: self.port_path.clone(),
            version: None,
        })
    }

    /// `devnum <n>` — set the device number (0-254; 255 unassigns).
    pub fn set_device_number(&mut self, n: u8) -> Result<()> {
        self.transport.command(&format!("devnum {n}"))?;
        Ok(())
    }

    // --- digital I/O ---

    /// `read` — current input values.
    pub fn read(&mut self) -> Result<u32> {
        let data = self.transport.command("read")?;
        protocol::parse_read(&data)
    }

    /// `write <values> <mask>` — set outputs (only masked bits change).
    pub fn write(&mut self, values: u32, mask: u32) -> Result<()> {
        self.transport
            .command(&format!("write {values:#x} {mask:#x}"))?;
        Ok(())
    }

    /// `state` — complete I/O state.
    pub fn state(&mut self) -> Result<IoState> {
        let data = self.transport.command("state")?;
        protocol::parse_state(&data)
    }

    // --- pin map ---

    /// `map get` — current pin map.
    pub fn map_get(&mut self) -> Result<PinMap> {
        let data = self.transport.command("map get")?;
        protocol::parse_map(&data)
    }

    /// `map set` from a typed [`PinMap`]. Extended fields (out_default,
    /// polarities) are zero; use [`Connection::map_set_hex`] to control them.
    pub fn map_set(&mut self, map: &PinMap) -> Result<()> {
        self.map_set_hex(&protocol::map_to_hex(map))
    }

    /// `map set <hex>` — raw 48-char hex map (see `toml` module for TOML
    /// conversion).
    pub fn map_set_hex(&mut self, hex: &str) -> Result<()> {
        self.transport.command(&format!("map set {hex}"))?;
        Ok(())
    }

    /// `map save` — persist the current map to flash.
    pub fn map_save(&mut self) -> Result<()> {
        self.transport.command("map save")?;
        Ok(())
    }

    /// `map default` — reset to the default map (all inputs, pull-down).
    pub fn map_default(&mut self) -> Result<()> {
        self.transport.command("map default")?;
        Ok(())
    }

    // --- pattern ---

    /// `pattern load` from typed steps. Returns the accepted step count.
    pub fn pattern_load(&mut self, steps: &[PatternStep]) -> Result<u16> {
        let hex = protocol::pattern_to_hex(steps)?;
        self.pattern_load_hex(&hex)
    }

    /// `pattern load <hex>` — raw count-prefixed step data.
    pub fn pattern_load_hex(&mut self, hex: &str) -> Result<u16> {
        let data = self.transport.command(&format!("pattern load {hex}"))?;
        protocol::parse_accepted(&data)
    }

    /// `pattern run <mode> <repeat>` — start playback.
    pub fn pattern_run(&mut self, mode: PatternMode, repeat: u16) -> Result<()> {
        self.transport
            .command(&protocol::pattern_run_command(mode, repeat))?;
        Ok(())
    }

    /// `pattern stop` — stop playback immediately.
    pub fn pattern_stop(&mut self) -> Result<()> {
        self.transport.command("pattern stop")?;
        Ok(())
    }

    /// `pattern status` — current playback status.
    pub fn pattern_status(&mut self) -> Result<PatternStatus> {
        let data = self.transport.command("pattern status")?;
        protocol::parse_pattern_status(&data)
    }

    // --- timestamp ---

    /// `ts arm <mask> <mode>` — arm timestamp capture.
    pub fn ts_arm(&mut self, mask: u32, mode: EdgeMode) -> Result<()> {
        self.transport
            .command(&protocol::ts_arm_command(mask, mode))?;
        Ok(())
    }

    /// `ts get <max>` — retrieve captured events (counted multi-line read).
    /// `timestamp_ns` is the host-computed as-is value; apply
    /// [`crate::reconcile`] for straddle correction across events.
    pub fn ts_get(&mut self, max_events: u16) -> Result<TimestampResult> {
        let (_, lines) = self
            .transport
            .command_counted(&format!("ts get {max_events}"))?;
        let events = lines
            .iter()
            .map(|line| protocol::parse_ts_event_line(line))
            .collect::<Result<Vec<_>>>()?;
        Ok(TimestampResult {
            events,
            reconciled: false,
        })
    }

    /// `ts disarm` — disarm capture and discard buffered events.
    pub fn ts_disarm(&mut self) -> Result<()> {
        self.transport.command("ts disarm")?;
        Ok(())
    }

    // --- events ---

    /// `subscribe on|off` — toggle input change push notifications.
    pub fn subscribe(&mut self, enable: bool) -> Result<()> {
        let arg = if enable { "on" } else { "off" };
        self.transport.command(&format!("subscribe {arg}"))?;
        Ok(())
    }

    /// Install a push event subscriber. Events (`! INPUT` etc.) arrive on
    /// the returned channel as they are received, including while other
    /// commands are in flight. A second call replaces the first subscriber.
    pub fn subscribe_events(&mut self) -> Receiver<PushEvent> {
        self.transport.subscribe_events()
    }

    // --- sync ---

    /// `sync arm` — prepare as slave.
    pub fn sync_arm(&mut self) -> Result<()> {
        self.transport.command("sync arm")?;
        Ok(())
    }

    /// `sync master` — prepare as master.
    pub fn sync_master(&mut self) -> Result<()> {
        self.transport.command("sync master")?;
        Ok(())
    }

    /// `sync start` — start sync pulse + 1 MHz clock (master only).
    pub fn sync_start(&mut self) -> Result<()> {
        self.transport.command("sync start")?;
        Ok(())
    }

    /// `sync stop` — stop clock output (master only).
    pub fn sync_stop(&mut self) -> Result<()> {
        self.transport.command("sync stop")?;
        Ok(())
    }

    /// `sync count` — current sync clock count.
    ///
    /// Single-line response (`OK count=N`, no data lines follow) — uses the
    /// plain read path, never the counted one.
    pub fn sync_count(&mut self) -> Result<u64> {
        let data = self.transport.command("sync count")?;
        protocol::parse_sync_count(&data)
    }

    /// `sync disarm` — release sync state (safe in any state).
    pub fn sync_disarm(&mut self) -> Result<()> {
        self.transport.command("sync disarm")?;
        Ok(())
    }

    // --- escape hatch ---

    /// Send an arbitrary command, returning the raw response line.
    pub fn raw(&mut self, command: &str) -> Result<String> {
        self.transport.raw(command)
    }

    /// Close the connection eagerly (equivalent to dropping it).
    pub fn close(self) -> Result<()> {
        Ok(())
    }
}
