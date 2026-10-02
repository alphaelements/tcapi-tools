//! High-level typed connection to one Pochi-DIO device.

use std::sync::mpsc::Receiver;
use std::time::Duration;

use crate::discovery;
use crate::error::{Result, SdkError};
use crate::protocol;
use crate::transport::{TrafficHook, Transport};
use crate::types::{
    Capabilities, DeviceInfo, EdgeMode, IoState, PatternMode, PatternStatus, PatternStep, PinMap,
    PushEvent, TimestampResult, TsStatus, VersionInfo, PROTO_VERSION,
};

/// An open connection to a Pochi-DIO device.
///
/// Opening asserts DTR and checks `version`: a device that does not report
/// `proto=2` is refused with [`SdkError::UnsupportedFirmware`]. The
/// connection closes when dropped; [`Connection::close`] exists for explicit,
/// eager shutdown.
pub struct Connection {
    transport: Transport,
    port_path: String,
    firmware: String,
}

impl Connection {
    /// Open a connection to the device at the given serial port path.
    pub fn open(port: &str) -> Result<Self> {
        Self::establish(Transport::open(port)?, port.to_string())
    }

    /// Verify the protocol version of a freshly opened transport.
    fn establish(mut transport: Transport, port_path: String) -> Result<Self> {
        let data = transport.command("version")?;
        // A pre-v2 device answers `version` in a different shape; say so
        // instead of reporting a bare parse error.
        let version = protocol::parse_version(&data).map_err(|_| {
            SdkError::UnsupportedFirmware(format!("unrecognised version response: {data}"))
        })?;
        if version.protocol_version != PROTO_VERSION {
            return Err(SdkError::UnsupportedFirmware(format!(
                "proto={} (this SDK speaks proto={PROTO_VERSION})",
                version.protocol_version
            )));
        }
        Ok(Self {
            transport,
            port_path,
            firmware: format!("{}.{}.{}", version.major, version.minor, version.patch),
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

    /// Wrap an already-open serial port (PTY tests, custom transports). The
    /// caller asserts DTR on real hardware; `version` is checked as in
    /// [`Connection::open`].
    pub fn from_port(port: Box<dyn serialport::SerialPort>) -> Result<Self> {
        Self::establish(Transport::from_port(port)?, String::new())
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

    /// `ping <value>` — echo test; returns the echoed value, failing with
    /// `Parse` when the device answers a different one.
    pub fn ping(&mut self, value: u32) -> Result<u32> {
        let data = self.transport.command(&format!("ping {value}"))?;
        let echoed = protocol::parse_pong(&data)?;
        if echoed != value {
            return Err(SdkError::Parse(format!(
                "ping {value} was answered with pong={echoed}"
            )));
        }
        Ok(echoed)
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
            version: Some(self.firmware.clone()),
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

    /// Attach a push event subscriber. Events (`! INPUT` etc.) arrive on
    /// the returned channel as they are received, including while other
    /// commands are in flight.
    ///
    /// The SDK owns the device `subscribe` state: it is switched on when the
    /// first subscriber attaches and off once the last receiver has been
    /// dropped (noticed lazily, before the next command). Every subscriber
    /// gets every event.
    pub fn subscribe_events(&mut self) -> Result<Receiver<PushEvent>> {
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
    /// Single-line response (`OK clocks=N`, no data lines follow) — uses the
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

    /// Send an arbitrary command, returning **every** line of the response
    /// unparsed (for a counted response: the header and all N lines). A
    /// device `ERR` is returned as a line, not as an error. `subscribe`, a
    /// line over 256 bytes and a line containing CR/LF are rejected locally
    /// with `InvalidArgument`.
    pub fn raw(&mut self, command: &str) -> Result<Vec<String>> {
        self.transport.raw(command)
    }

    /// Close the connection eagerly (equivalent to dropping it).
    pub fn close(self) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{pong_for, FakeDevice};
    use assert_matches::assert_matches;

    fn connect(
        version_reply: &'static str,
        extra: impl Fn(&str) -> Option<Vec<String>> + Send + 'static,
    ) -> (Result<Connection>, FakeDevice) {
        let (reader, writer, device) = FakeDevice::spawn(move |cmd| {
            if cmd == "version" {
                return vec![version_reply.to_string()];
            }
            if let Some(pong) = pong_for(cmd) {
                return pong;
            }
            extra(cmd).unwrap_or_else(|| vec!["ERR UNKNOWN_CMD".to_string()])
        });
        let mut transport = Transport::from_io(Box::new(reader), Box::new(writer));
        transport.set_timeout(Duration::from_millis(200));
        (Connection::establish(transport, "fake".into()), device)
    }

    #[test]
    fn open_checks_version_and_accepts_proto_2() {
        let (conn, dev) = connect("OK fw=0.1.3 proto=2", |_| None);
        assert!(conn.is_ok());
        assert_eq!(dev.commands(), ["version"]);
    }

    #[test]
    fn info_reports_port_and_firmware_from_the_open_handshake() {
        let (conn, _dev) = connect("OK fw=0.1.3 proto=2", |cmd| {
            (cmd == "info").then(|| vec!["OK uid=0123456789ABCDEF devnum=7".to_string()])
        });
        let info = conn.unwrap().info().unwrap();
        assert_eq!(info.uid, "0123456789ABCDEF");
        assert_eq!(info.device_number, Some(7));
        assert_eq!(info.port, "fake");
        assert_eq!(info.version.as_deref(), Some("0.1.3"));
    }

    #[test]
    fn open_rejects_other_protocol_versions() {
        for reply in ["OK fw=0.1.3 proto=1", "OK fw=0.1.3 proto=3"] {
            let (conn, _dev) = connect(reply, |_| None);
            assert_matches!(conn.err(), Some(SdkError::UnsupportedFirmware(m)) if m.contains("proto="));
        }
    }

    #[test]
    fn open_rejects_pre_v2_version_reply_as_unsupported_firmware() {
        let (conn, _dev) = connect("OK v0.1.0 proto=1", |_| None);
        assert_matches!(conn.err(), Some(SdkError::UnsupportedFirmware(_)));
    }

    #[test]
    fn open_fails_when_the_device_does_not_answer() {
        let (reader, writer, _dev) = FakeDevice::spawn(|_| vec![]);
        let mut transport = Transport::from_io(Box::new(reader), Box::new(writer));
        transport.set_timeout(Duration::from_millis(100));
        assert_matches!(
            Connection::establish(transport, String::new()).err(),
            Some(SdkError::Timeout)
        );
    }

    #[test]
    fn ping_returns_the_echoed_value() {
        let (conn, _dev) = connect("OK fw=0.1.3 proto=2", |_| None);
        assert_eq!(conn.unwrap().ping(0xFFFF_FFFF).unwrap(), 0xFFFF_FFFF);
    }

    #[test]
    fn ping_fails_with_parse_on_a_different_value() {
        let (reader, writer, _dev) = FakeDevice::spawn(|cmd| match cmd {
            "version" => vec!["OK fw=0.1.3 proto=2".to_string()],
            _ => vec!["OK pong=1".to_string()],
        });
        let transport = Transport::from_io(Box::new(reader), Box::new(writer));
        let mut conn = Connection::establish(transport, String::new()).unwrap();
        assert_matches!(conn.ping(2), Err(SdkError::Parse(_)));
    }

    #[test]
    fn subscribe_events_switches_the_device_on_once() {
        let (conn, dev) = connect("OK fw=0.1.3 proto=2", |cmd| {
            (cmd == "subscribe on").then(|| vec!["OK".to_string()])
        });
        let mut conn = conn.unwrap();
        let _a = conn.subscribe_events().unwrap();
        let _b = conn.subscribe_events().unwrap();
        assert_eq!(dev.commands(), ["version", "subscribe on"]);
    }

    #[test]
    fn raw_refuses_subscribe_and_returns_all_lines() {
        let (conn, dev) = connect("OK fw=0.1.3 proto=2", |cmd| {
            (cmd == "help").then(|| vec!["OK count=1".to_string(), "  help  Help".to_string()])
        });
        let mut conn = conn.unwrap();
        assert_matches!(conn.raw("subscribe on"), Err(SdkError::InvalidArgument(_)));
        assert_eq!(conn.raw("help").unwrap(), ["OK count=1", "  help  Help"]);
        assert_eq!(dev.commands(), ["version", "help"]);
    }
}
