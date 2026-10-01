//! High-level typed connection to one Pochi-DIO device.

use std::sync::mpsc::Receiver;
use std::time::Duration;

use crate::discovery;
use crate::error::{Result, SdkError};
use crate::protocol;
use crate::transport::{TrafficHook, Transport};
use crate::types::{
    Capabilities, DeviceInfo, EdgeMode, IoState, PatternMode, PatternStatus, PatternStep, PinMap,
    PushEvent, TimestampResult, TsStatus, VersionInfo,
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

    /// Install an observer for every line exchanged with the device
    /// (command-log UIs, debug tracing). A second call replaces the first;
    /// `None` removes it. See [`TrafficHook`] for threading caveats.
    pub fn set_traffic_hook(&mut self, hook: Option<TrafficHook>) {
        self.transport.set_traffic_hook(hook);
    }

    // --- device information ---

    /// `version` — firmware and protocol version.
    pub fn version(&mut self) -> Result<VersionInfo> {
        let data = self.transport.command("version")?;
        protocol::parse_version(&data)
    }

    /// `caps` — device capabilities. Pre-v2 firmware fails to parse.
    pub fn caps(&mut self) -> Result<Capabilities> {
        let data = self.transport.command("caps")?;
        protocol::parse_caps(&data)
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
            .command(&protocol::write_command(values, mask)?)?;
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

    /// `map set` from a typed [`PinMap`]; validated (R-M1) before sending.
    pub fn map_set(&mut self, map: &PinMap) -> Result<()> {
        self.transport.command(&protocol::map_set_command(map)?)?;
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

    /// `pattern add` — append steps to the pattern buffer, split into as many
    /// lines as the 256-byte line limit requires. Returns the total step
    /// count after the last line.
    pub fn pattern_add(&mut self, steps: &[PatternStep]) -> Result<u16> {
        let mut total = 0;
        for line in protocol::pattern_add_commands(steps)? {
            let data = self.transport.command(&line)?;
            total = protocol::parse_pattern_total(&data)?;
        }
        Ok(total)
    }

    /// Replace the pattern buffer: `pattern reset`, then [`Self::pattern_add`].
    /// Returns the total step count.
    pub fn pattern_load(&mut self, steps: &[PatternStep]) -> Result<u16> {
        protocol::pattern_add_commands(steps)?;
        self.pattern_reset()?;
        self.pattern_add(steps)
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

    /// `pattern reset` — pattern engine soft reset (FW v0.1.3+, `FEAT_RESET`).
    ///
    /// Stops the state machine, clears the loaded pattern buffer, and
    /// returns the engine to `Idle`. USB stays up; the connection remains
    /// usable.
    pub fn pattern_reset(&mut self) -> Result<()> {
        self.transport.command("pattern reset")?;
        Ok(())
    }

    // --- reset ---

    /// `reset` — full chip soft reset (FW v0.1.3+, `FEAT_RESET`).
    ///
    /// The device responds `OK`, drains the CDC TX ring for ~50 ms, then
    /// calls `SCB::sys_reset()`. The USB port re-enumerates, so this method
    /// consumes the connection — callers must `discover` and `open` again
    /// after the device comes back.
    pub fn system_reset(self) -> Result<()> {
        let mut t = self.transport;
        t.command("reset")?;
        Ok(())
    }

    /// `bootsel` — reboot into BOOTSEL mass-storage mode for UF2 reflash
    /// (FW v0.1.3+, `FEAT_RESET`).
    ///
    /// Like [`Connection::system_reset`] the device responds `OK`, then
    /// re-enumerates as a USB mass-storage device. Callers must close this
    /// connection and either wait for the BOOTSEL drive or flash the device.
    pub fn bootsel_reset(self) -> Result<()> {
        let mut t = self.transport;
        t.command("bootsel")?;
        Ok(())
    }

    // --- timestamp ---

    /// `ts arm <mask> <mode>` — arm timestamp capture.
    pub fn ts_arm(&mut self, mask: u32, mode: EdgeMode) -> Result<()> {
        self.transport
            .command(&protocol::ts_arm_command(mask, mode)?)?;
        Ok(())
    }

    /// `ts status` — capture state and pending event count.
    pub fn ts_status(&mut self) -> Result<TsStatus> {
        let data = self.transport.command("ts status")?;
        protocol::parse_ts_status(&data)
    }

    /// `ts get <max>` — retrieve captured events (counted multi-line read).
    /// Use [`crate::TimestampEvent::ns`] for the nanosecond value and
    /// [`crate::reconcile`] for straddle correction across events.
    ///
    /// The returned [`TimestampResult::overflow`] is `true` if the FW
    /// reported a ring overflow since the last `ts get` (FW v0.1.2+).
    /// Note that `max_events` is clamped FW-side: as of FW v0.1.2 a single
    /// response carries at most 85 events, so draining a full 256-event
    /// ring may need multiple calls.
    pub fn ts_get(&mut self, max_events: u16) -> Result<TimestampResult> {
        let (data, lines) = self
            .transport
            .command_counted(&format!("ts get {max_events}"))?;
        let (count, overflow) = protocol::parse_ts_get_header(&data)?;
        if count as usize != lines.len() {
            return Err(SdkError::Parse(format!(
                "ts get header announced {count} events but {} lines were read",
                lines.len()
            )));
        }
        let events = lines
            .iter()
            .map(|line| protocol::parse_ts_event_line(line))
            .collect::<Result<Vec<_>>>()?;
        Ok(TimestampResult {
            events,
            reconciled: false,
            overflow,
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
