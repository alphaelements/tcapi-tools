//! High-level typed connection to one Pochi-DIO device.

use std::sync::mpsc::Receiver;
use std::time::Duration;

use crate::discovery;
use crate::error::{Result, SdkError};
use crate::heartbeat::{self, Heartbeat};
use crate::protocol;
use crate::transport::{SharedTransport, TrafficHook, Transport};
use crate::types::{
    Capabilities, DeviceInfo, EdgeMode, IoState, Pads, PatternMode, PatternStatus, PatternStep,
    PinMap, PushEvent, ResetInfo, SafetyConfig, SafetyState, TimestampResult, TsStatus,
    VersionInfo, PROTO_VERSION,
};

/// An open connection to a Pochi-DIO device.
///
/// Opening asserts DTR and checks `version`: a device that does not report
/// `proto=2` is refused with [`SdkError::UnsupportedFirmware`]. The
/// connection closes when dropped; [`Connection::close`] exists for explicit,
/// eager shutdown. Closing or dropping never sends a command and never
/// changes the outputs (protocol-reference.md section 2).
pub struct Connection {
    transport: SharedTransport,
    port_path: String,
    firmware: String,
}

impl Connection {
    /// Open a connection to the device at the given serial port path.
    pub fn open(port: &str) -> Result<Self> {
        Self::establish(Transport::open(port)?, port.to_string())
    }

    /// Verify the protocol version of a freshly opened transport.
    pub(crate) fn establish(mut transport: Transport, port_path: String) -> Result<Self> {
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
            transport: SharedTransport::new(transport),
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
        // Only fails when another thread panicked while holding the
        // transport; the next command then reports `Disconnected`.
        let _ = self.transport.set_timeout(timeout);
    }

    /// Install an observer for every line exchanged with the device
    /// (command-log UIs, debug tracing). A second call replaces the first;
    /// `None` removes it. See [`TrafficHook`] for threading caveats.
    pub fn set_traffic_hook(&mut self, hook: Option<TrafficHook>) {
        // As in `set_timeout`: a poisoned transport is reported by the next
        // command.
        let _ = self.transport.set_traffic_hook(hook);
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
        self.transport.ping(value)
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

    /// `pattern run <mode> <repeat>` — start playback. `Once` plays one pass
    /// and ignores `repeat`; `Loop` needs a `repeat` of 1-65535.
    pub fn pattern_run(&mut self, mode: PatternMode, repeat: u16) -> Result<()> {
        self.transport
            .command(&protocol::pattern_run_command(mode, repeat)?)?;
        Ok(())
    }

    /// `pattern run once` — play the loaded pattern one time.
    pub fn pattern_run_once(&mut self) -> Result<()> {
        self.pattern_run(PatternMode::Once, 1)
    }

    /// `pattern run loop <repeat>` — play the loaded pattern `repeat` times
    /// (1-65535; there is no infinite mode).
    pub fn pattern_run_loop(&mut self, repeat: u16) -> Result<()> {
        self.pattern_run(PatternMode::Loop, repeat)
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
        self.transport.command("reset")?;
        Ok(())
    }

    /// `bootsel` — reboot into BOOTSEL mass-storage mode for UF2 reflash
    /// (FW v0.1.3+, `FEAT_RESET`).
    ///
    /// Like [`Connection::system_reset`] the device responds `OK`, then
    /// re-enumerates as a USB mass-storage device. Callers must close this
    /// connection and either wait for the BOOTSEL drive or flash the device.
    pub fn bootsel_reset(self) -> Result<()> {
        self.transport.command("bootsel")?;
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

    /// `ts get <max>` — retrieve captured events (counted multi-line read);
    /// `max_events` must be 1-85, anything else is rejected locally.
    /// Use [`crate::TimestampEvent::ns`] for the nanosecond value and
    /// [`crate::reconcile`] for straddle correction across events.
    ///
    /// The returned [`TimestampResult::overflow`] is `true` if the FW
    /// reported a ring overflow since the last `ts get` (FW v0.1.2+).
    /// A single response carries at most 85 events, so draining a full
    /// 256-event ring takes several calls.
    pub fn ts_get(&mut self, max_events: u16) -> Result<TimestampResult> {
        let (data, lines) = self
            .transport
            .command_counted(&protocol::ts_get_command(max_events)?)?;
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

    // --- help ---

    /// `help` — the device's command list, one entry per line (counted
    /// response); the two-space indent of the wire form is removed.
    pub fn help(&mut self) -> Result<Vec<String>> {
        let (data, lines) = self.transport.command_counted("help")?;
        let count = protocol::parse_count_field(&data)?;
        if count != lines.len() as u64 {
            return Err(SdkError::Parse(format!(
                "help header announced {count} lines but {} were read",
                lines.len()
            )));
        }
        Ok(lines
            .iter()
            .map(|line| {
                line.trim_end()
                    .strip_prefix("  ")
                    .unwrap_or(line.trim_end())
                    .to_string()
            })
            .collect())
    }

    // --- safety functions ---

    /// `wdog <ms>` — enable (`100..=10000`) or disable (`0`) the watchdog.
    /// CDC only. The watchdog is off after every restart; whoever enables it
    /// must keep a heartbeat going ([`Connection::start_heartbeat`]).
    pub fn wdog(&mut self, ms: u32) -> Result<()> {
        self.transport.command(&protocol::wdog_command(ms)?)?;
        Ok(())
    }

    /// `safety` — the safety state (watchdog, failsafe latch, `usbsafe`,
    /// number of exclusive groups). The source of truth for `! FAILSAFE`.
    pub fn safety(&mut self) -> Result<SafetyState> {
        let data = self.transport.command("safety")?;
        protocol::parse_safety(&data)
    }

    /// `failsafe clear` — release the failsafe latch (CDC only). The outputs
    /// stay where they are and the watchdog timer restarts.
    pub fn failsafe_clear(&mut self) -> Result<()> {
        self.transport.command("failsafe clear")?;
        Ok(())
    }

    /// `outputs reset` — put every output at its `def` (the safe state) and
    /// stop a running pattern. Always succeeds on the device, also with the
    /// latch set.
    pub fn outputs_reset(&mut self) -> Result<()> {
        self.transport.command("outputs reset")?;
        Ok(())
    }

    /// `excl set <mask>...` — replace all exclusive groups atomically (1-16
    /// masks of at least 2 output pins; CDC only). A violated state is
    /// [`SdkError::Exclusive`]; a mask with a non-output pin is `BadParam`
    /// (the device knows the map).
    pub fn excl_set(&mut self, masks: &[u32]) -> Result<()> {
        self.transport
            .command(&protocol::excl_set_command(masks)?)?;
        Ok(())
    }

    /// `excl clear` — remove all exclusive groups (CDC only).
    pub fn excl_clear(&mut self) -> Result<()> {
        self.transport.command("excl clear")?;
        Ok(())
    }

    /// `excl get` — the masks of the exclusive groups in the order they were
    /// set (counted response).
    pub fn excl_get(&mut self) -> Result<Vec<u32>> {
        let (header, lines) = self.transport.command_counted("excl get")?;
        protocol::parse_excl_get(&header, &lines)
    }

    /// `usbsafe on|off` — failsafe when the USB link is lost (CDC only).
    pub fn usbsafe(&mut self, on: bool) -> Result<()> {
        self.transport.command(&protocol::usbsafe_command(on))?;
        Ok(())
    }

    /// `rstinfo` — cause and time of the last restart.
    pub fn rstinfo(&mut self) -> Result<ResetInfo> {
        let data = self.transport.command("rstinfo")?;
        protocol::parse_rstinfo(&data)
    }

    /// `pads` — the recorded outputs and the level read back from the pads.
    pub fn pads(&mut self) -> Result<Pads> {
        let data = self.transport.command("pads")?;
        protocol::parse_pads(&data)
    }

    /// Make the device equal to a `safety.toml` (config-files.md section 7,
    /// DD-16) and check the result.
    ///
    /// The commands go out in this order and nothing else:
    /// `excl set <masks>` when the configuration has groups, `excl clear`
    /// only when it has none, `usbsafe on|off`, `wdog <ms>` (last, so the
    /// watchdog cannot trip while the rest is being sent). `excl clear` is
    /// never sent before `excl set`: `excl set` replaces atomically, and a
    /// failed `excl set` after a clear would leave the device with less
    /// protection than before.
    ///
    /// A value the device would refuse is [`SdkError::InvalidArgument`] and
    /// nothing is sent. The first error answered by the device stops the
    /// apply: later commands are not sent and the error keeps its code
    /// (`BadParam`, `Busy`, ...). Accepted commands stay in effect (no
    /// rollback); call [`Connection::safety`] and [`Connection::excl_get`]
    /// to see what is set. Applying needs the pins of the groups to be
    /// outputs already: apply `map.toml` first.
    ///
    /// After the last command, `safety` and `excl get` are read back and must
    /// equal the configuration (`wdog_ms`, `usbsafe`, number and masks of the
    /// groups); a difference is [`SdkError::SafetyMismatch`]. Returns the
    /// `safety` state that was read, which also shows a failsafe latch that
    /// was set before (the latch is not part of the file).
    ///
    /// With a watchdog configured, start the heartbeat afterwards.
    pub fn apply_safety(&mut self, config: &SafetyConfig) -> Result<SafetyState> {
        for command in config.commands()? {
            self.transport.command(&command)?;
        }
        let state = self.safety()?;
        let groups = self.excl_get()?;
        let mut diffs = Vec::new();
        if state.wdog_ms != config.watchdog_ms {
            diffs.push(format!(
                "wdog_ms is {}, expected {}",
                state.wdog_ms, config.watchdog_ms
            ));
        }
        if state.usbsafe != config.usbsafe {
            diffs.push(format!(
                "usbsafe is {}, expected {}",
                u8::from(state.usbsafe),
                u8::from(config.usbsafe)
            ));
        }
        if usize::from(state.excl) != config.groups.len() {
            diffs.push(format!(
                "excl is {}, expected {}",
                state.excl,
                config.groups.len()
            ));
        }
        if groups.len() != config.groups.len() {
            diffs.push(format!(
                "excl get returned {} groups, expected {}",
                groups.len(),
                config.groups.len()
            ));
        }
        for (i, (got, want)) in groups.iter().zip(&config.groups).enumerate() {
            if got != want {
                diffs.push(format!("group {i} is {got:#010x}, expected {want:#010x}"));
            }
        }
        if diffs.is_empty() {
            Ok(state)
        } else {
            Err(SdkError::SafetyMismatch(diffs.join("; ")))
        }
    }

    /// Start the watchdog heartbeat: a dedicated thread sends `ping` every
    /// `timeout_ms / 4` (at most 1 s) so the device keeps seeing `OK`
    /// answers. `timeout_ms` is the value given to [`Connection::wdog`]
    /// (`100..=10000`). See [`Heartbeat`] for the rules (serialised with
    /// every other command, one failure is reported and not retried,
    /// dropping the connection or the heartbeat changes no output).
    pub fn start_heartbeat(&mut self, timeout_ms: u32) -> Result<Heartbeat> {
        heartbeat::start(&self.transport, timeout_ms)
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
    use crate::types::SafetyConfig;
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

    const FW: &str = "OK fw=0.1.3 proto=2";

    #[test]
    fn help_returns_the_counted_lines_without_their_indent() {
        let (conn, dev) = connect(FW, |cmd| {
            (cmd == "help").then(|| {
                vec![
                    "OK count=2".to_string(),
                    "  version                                  Get firmware version".to_string(),
                    "  help                                     Show this help".to_string(),
                ]
            })
        });
        let lines = conn.unwrap().help().unwrap();
        assert_eq!(
            lines,
            [
                "version                                  Get firmware version",
                "help                                     Show this help"
            ]
        );
        assert_eq!(dev.commands(), ["version", "help"]);
    }

    #[test]
    fn pattern_run_once_and_loop_send_the_documented_text() {
        let (conn, dev) = connect(FW, |cmd| {
            cmd.starts_with("pattern run")
                .then(|| vec!["OK".to_string()])
        });
        let mut conn = conn.unwrap();
        conn.pattern_run_once().unwrap();
        conn.pattern_run_loop(10).unwrap();
        conn.pattern_run(PatternMode::Once, 7).unwrap();
        conn.pattern_run(PatternMode::Loop, 65535).unwrap();
        assert_eq!(
            dev.commands(),
            [
                "version",
                "pattern run once",
                "pattern run loop 10",
                "pattern run once",
                "pattern run loop 65535"
            ]
        );
    }

    #[test]
    fn pattern_run_loop_rejects_zero_without_sending() {
        let (conn, dev) = connect(FW, |_| None);
        let mut conn = conn.unwrap();
        assert_matches!(conn.pattern_run_loop(0), Err(SdkError::InvalidArgument(_)));
        assert_eq!(dev.commands(), ["version"]);
    }

    #[test]
    fn ts_get_rejects_a_max_outside_1_to_85_without_sending() {
        let (conn, dev) = connect(FW, |cmd| {
            (cmd == "ts get 85").then(|| vec!["OK count=0 overflow=0".to_string()])
        });
        let mut conn = conn.unwrap();
        for bad in [0, 86, 256] {
            assert_matches!(conn.ts_get(bad), Err(SdkError::InvalidArgument(_)), "{bad}");
        }
        assert!(conn.ts_get(85).unwrap().events.is_empty());
        assert_eq!(dev.commands(), ["version", "ts get 85"]);
    }

    #[test]
    fn ts_get_returns_the_events_of_the_counted_response() {
        let (conn, _dev) = connect(FW, |cmd| {
            (cmd == "ts get 5").then(|| {
                vec![
                    "OK count=2 overflow=1".to_string(),
                    "  in=0x00000005 c=1000 p=7 s=1".to_string(),
                    "  in=0x0000000a c=2000 p=0 s=0".to_string(),
                ]
            })
        });
        let result = conn.unwrap().ts_get(5).unwrap();
        assert!(result.overflow);
        assert_eq!(result.events.len(), 2);
        assert_eq!(result.events[0].ns(40), 1_000_280);
        assert_eq!(result.events[1].ns(40), 2_000_000);
    }

    #[test]
    fn ts_status_reports_armed_pending_and_overflow() {
        let (conn, _dev) = connect(FW, |cmd| {
            (cmd == "ts status").then(|| vec!["OK armed=1 pending=3 overflow=1".to_string()])
        });
        let status = conn.unwrap().ts_status().unwrap();
        assert_eq!(
            (status.armed, status.pending, status.overflow),
            (true, 3, true)
        );
    }

    /// 256 steps (the pattern buffer size) go out as `pattern reset` plus
    /// several `pattern add` lines, none over the 256-byte line limit.
    #[test]
    fn pattern_load_sends_256_steps_in_multiple_lines() {
        let total = std::sync::Arc::new(std::sync::Mutex::new(0u16));
        let (conn, dev) = connect(FW, {
            let total = std::sync::Arc::clone(&total);
            move |cmd| {
                if cmd == "pattern reset" {
                    *total.lock().unwrap() = 0;
                    return Some(vec!["OK".to_string()]);
                }
                let steps = cmd.strip_prefix("pattern add ")?;
                let mut t = total.lock().unwrap();
                *t += steps.split(' ').count() as u16;
                Some(vec![format!("OK total={}", *t)])
            }
        });
        let steps: Vec<PatternStep> = (0..256u32)
            .map(|i| PatternStep {
                out_bits: i & 0x3,
                hold_ticks: i + 1,
            })
            .collect();
        assert_eq!(conn.unwrap().pattern_load(&steps).unwrap(), 256);

        let sent = dev.commands();
        assert_eq!(sent[1], "pattern reset");
        let adds: Vec<&String> = sent[2..].iter().collect();
        assert!(adds.len() > 1, "256 steps must not fit in one line");
        assert!(adds.iter().all(|l| l.len() <= protocol::MAX_LINE_BYTES));
        // The steps arrive in order, none lost or duplicated.
        let wire: Vec<&str> = adds
            .iter()
            .flat_map(|l| l.strip_prefix("pattern add ").unwrap().split(' '))
            .collect();
        let expected: Vec<String> = steps.iter().map(|s| s.to_text().unwrap()).collect();
        assert_eq!(wire, expected);
    }

    #[test]
    fn pattern_load_rejects_a_bad_pattern_before_resetting_the_device() {
        let (conn, dev) = connect(FW, |_| None);
        let mut conn = conn.unwrap();
        let bad = [PatternStep {
            out_bits: 0x1,
            hold_ticks: 0,
        }];
        assert_matches!(conn.pattern_load(&bad), Err(SdkError::InvalidArgument(_)));
        assert_matches!(conn.pattern_load(&[]), Err(SdkError::InvalidArgument(_)));
        assert_eq!(dev.commands(), ["version"]);
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

    // --- safety functions ---

    use std::sync::{Arc, Mutex};

    /// A device that models the volatile safety state, so `apply_safety` can
    /// be read back. `fail_on` makes the named command answer `ERR BAD_PARAM`.
    #[derive(Default)]
    struct SafetyDevice {
        wdog_ms: u32,
        usbsafe: bool,
        groups: Vec<String>,
        fail_on: Option<&'static str>,
        /// Report a wrong `wdog_ms` / group list in the read-back.
        lie: bool,
        /// Report the opposite `usbsafe` in `safety` only.
        lie_usbsafe: bool,
        /// `excl get` returns this many groups more (positive) or fewer
        /// (negative) than were set, while `safety` reports `excl=` truthfully.
        excl_get_extra: i8,
    }

    impl SafetyDevice {
        fn handle(&mut self, cmd: &str) -> Option<Vec<String>> {
            if self.fail_on.is_some_and(|f| cmd.starts_with(f)) {
                return Some(vec!["ERR BAD_PARAM".to_string()]);
            }
            let ok = || Some(vec!["OK".to_string()]);
            match cmd.split_whitespace().collect::<Vec<_>>().as_slice() {
                ["excl", "set", masks @ ..] => {
                    self.groups = masks.iter().map(|m| (*m).to_string()).collect();
                    ok()
                }
                ["excl", "clear"] => {
                    self.groups.clear();
                    ok()
                }
                ["usbsafe", v] => {
                    self.usbsafe = *v == "on";
                    ok()
                }
                ["wdog", ms] => {
                    self.wdog_ms = ms.parse().unwrap();
                    ok()
                }
                ["safety"] => Some(vec![format!(
                    "OK wdog_ms={} remaining_ms={} failsafe=0 cause=none usbsafe={} excl={}",
                    self.wdog_ms + u32::from(self.lie),
                    self.wdog_ms,
                    u8::from(self.usbsafe != self.lie_usbsafe),
                    self.groups.len()
                )]),
                ["excl", "get"] => {
                    let mut masks: Vec<u32> = self
                        .groups
                        .iter()
                        .enumerate()
                        .map(|(i, m)| {
                            let m = u32::from_str_radix(m.trim_start_matches("0x"), 16).unwrap();
                            // A lying device reports the first group wrong.
                            if self.lie && i == 0 {
                                m ^ 0x100
                            } else {
                                m
                            }
                        })
                        .collect();
                    if self.excl_get_extra >= 0 {
                        masks.extend((0..self.excl_get_extra).map(|_| 0x3));
                    } else {
                        masks.truncate(
                            masks
                                .len()
                                .saturating_sub(self.excl_get_extra.unsigned_abs().into()),
                        );
                    }
                    let mut lines = vec![format!("OK count={}", masks.len())];
                    lines.extend(masks.iter().map(|m| format!("  mask=0x{m:08x}")));
                    Some(lines)
                }
                _ => None,
            }
        }
    }

    fn safety_conn(dev_state: SafetyDevice) -> (Connection, FakeDevice, Arc<Mutex<SafetyDevice>>) {
        let state = Arc::new(Mutex::new(dev_state));
        let (conn, dev) = connect(FW, {
            let state = Arc::clone(&state);
            move |cmd| state.lock().unwrap().handle(cmd)
        });
        (conn.unwrap(), dev, state)
    }

    fn full_cfg() -> SafetyConfig {
        SafetyConfig {
            watchdog_ms: 800,
            usbsafe: true,
            groups: vec![0xc, 0x18],
        }
    }

    #[test]
    fn safety_commands_send_the_documented_text_and_parse_the_answers() {
        let (conn, dev) = connect(FW, |cmd| {
            Some(match cmd {
                "safety" => vec![
                    "OK wdog_ms=500 remaining_ms=377 failsafe=0 cause=none usbsafe=1 excl=2"
                        .to_string(),
                ],
                "rstinfo" => vec!["OK cause=por uptime_ms=1500 boot=0x00000001".to_string()],
                "pads" => vec!["OK out=0x00000005 pad=0x00000001".to_string()],
                "excl get" => vec![
                    "OK count=2".to_string(),
                    "  mask=0x0000000c".to_string(),
                    "  mask=0x00000018".to_string(),
                ],
                "wdog 500" | "wdog 0" | "failsafe clear" | "outputs reset" | "excl set 0xc"
                | "excl clear" | "usbsafe on" | "usbsafe off" => vec!["OK".to_string()],
                _ => return None,
            })
        });
        let mut c = conn.unwrap();
        c.wdog(500).unwrap();
        c.wdog(0).unwrap();
        c.failsafe_clear().unwrap();
        c.outputs_reset().unwrap();
        c.excl_set(&[0xc]).unwrap();
        c.excl_clear().unwrap();
        c.usbsafe(true).unwrap();
        c.usbsafe(false).unwrap();
        let st = c.safety().unwrap();
        assert_eq!((st.wdog_ms, st.remaining_ms, st.excl), (500, 377, 2));
        assert_eq!(c.excl_get().unwrap(), [0xc, 0x18]);
        assert_eq!(c.rstinfo().unwrap().uptime_ms, 1500);
        assert_eq!(c.pads().unwrap().pad, 1);
        assert_eq!(
            dev.commands(),
            [
                "version",
                "wdog 500",
                "wdog 0",
                "failsafe clear",
                "outputs reset",
                "excl set 0xc",
                "excl clear",
                "usbsafe on",
                "usbsafe off",
                "safety",
                "excl get",
                "rstinfo",
                "pads"
            ]
        );
    }

    #[test]
    fn safety_commands_refuse_bad_arguments_without_sending() {
        let (conn, dev) = connect(FW, |_| None);
        let mut c = conn.unwrap();
        assert_matches!(c.wdog(99), Err(SdkError::InvalidArgument(_)));
        assert_matches!(c.wdog(10_001), Err(SdkError::InvalidArgument(_)));
        assert_matches!(c.excl_set(&[]), Err(SdkError::InvalidArgument(_)));
        assert_matches!(c.excl_set(&[0x1]), Err(SdkError::InvalidArgument(_)));
        assert_eq!(dev.commands(), ["version"]);
    }

    #[test]
    fn failsafe_and_exclusive_errors_are_typed_with_their_data() {
        let (conn, _dev) = connect(FW, |cmd| {
            Some(vec![match cmd {
                "write 0x1 0x1" => "ERR FAILSAFE".to_string(),
                "write 0x8 0x8" => "ERR EXCLUSIVE group=1 mask=0x0000000c".to_string(),
                "wdog 100" => "ERR EXCLUSIVE group=0 mask=0x3 future=1".to_string(),
                _ => return None,
            }])
        });
        let mut c = conn.unwrap();
        assert_matches!(c.write(1, 1), Err(SdkError::Failsafe));
        assert_matches!(
            c.write(8, 8),
            Err(SdkError::Exclusive {
                group: 1,
                mask: 0xc
            })
        );
        // Further key=value tokens never make the line unparseable.
        assert_matches!(c.wdog(100), Err(SdkError::Exclusive { group: 0, mask: 3 }));
    }

    #[test]
    fn excl_get_with_a_short_counted_response_is_a_parse_error() {
        let (conn, _dev) = connect(FW, |cmd| {
            (cmd == "excl get").then(|| vec!["OK count=2".to_string(), "  mask=0x3".to_string()])
        });
        let mut c = conn.unwrap();
        // The second line never arrives: the transport times out.
        assert_matches!(c.excl_get(), Err(SdkError::Timeout));
    }

    #[test]
    fn apply_safety_sends_dd16_order_then_reads_back() {
        let (mut c, dev, state) = safety_conn(SafetyDevice::default());
        let st = c.apply_safety(&full_cfg()).unwrap();
        assert_eq!(
            dev.commands(),
            [
                "version",
                "excl set 0xc 0x18",
                "usbsafe on",
                "wdog 800",
                "safety",
                "excl get"
            ]
        );
        assert_eq!((st.wdog_ms, st.usbsafe, st.excl), (800, true, 2));
        assert_eq!(state.lock().unwrap().groups, ["0xc", "0x18"]);
    }

    #[test]
    fn apply_safety_without_groups_clears_them_and_never_sets() {
        let (mut c, dev, _state) = safety_conn(SafetyDevice {
            groups: vec!["0x3".into()],
            ..SafetyDevice::default()
        });
        c.apply_safety(&SafetyConfig::default()).unwrap();
        assert_eq!(
            dev.commands(),
            [
                "version",
                "excl clear",
                "usbsafe off",
                "wdog 0",
                "safety",
                "excl get"
            ]
        );
    }

    #[test]
    fn apply_safety_never_sends_excl_clear_before_excl_set() {
        let (mut c, dev, _state) = safety_conn(SafetyDevice::default());
        c.apply_safety(&full_cfg()).unwrap();
        assert!(!dev.commands().iter().any(|c| c == "excl clear"));
    }

    #[test]
    fn apply_safety_stops_at_the_first_error_and_reports_its_code() {
        for (fail_on, sent) in [
            ("excl set", vec!["excl set 0xc 0x18"]),
            ("usbsafe", vec!["excl set 0xc 0x18", "usbsafe on"]),
            ("wdog", vec!["excl set 0xc 0x18", "usbsafe on", "wdog 800"]),
        ] {
            let (mut c, dev, _state) = safety_conn(SafetyDevice {
                fail_on: Some(fail_on),
                ..SafetyDevice::default()
            });
            assert_matches!(
                c.apply_safety(&full_cfg()),
                Err(SdkError::BadParam),
                "{fail_on}"
            );
            let mut want = vec!["version"];
            want.extend(sent);
            // No later command and no read-back after the error.
            assert_eq!(dev.commands(), want, "{fail_on}");
        }
    }

    #[test]
    fn apply_safety_refuses_an_invalid_config_before_sending_anything() {
        let (mut c, dev, _state) = safety_conn(SafetyDevice::default());
        let bad = SafetyConfig {
            watchdog_ms: 50,
            ..full_cfg()
        };
        assert_matches!(c.apply_safety(&bad), Err(SdkError::InvalidArgument(_)));
        assert_eq!(dev.commands(), ["version"]);
    }

    #[test]
    fn apply_safety_detects_a_read_back_that_differs() {
        let (mut c, _dev, _state) = safety_conn(SafetyDevice {
            lie: true,
            ..SafetyDevice::default()
        });
        assert_matches!(
            c.apply_safety(&full_cfg()),
            Err(SdkError::SafetyMismatch(m)) if m.contains("wdog_ms") && m.contains("group 0")
        );
    }

    #[test]
    fn apply_safety_detects_a_differing_usbsafe_alone() {
        let (mut c, _dev, _state) = safety_conn(SafetyDevice {
            lie_usbsafe: true,
            ..SafetyDevice::default()
        });
        assert_matches!(
            c.apply_safety(&full_cfg()),
            Err(SdkError::SafetyMismatch(m)) if m == "usbsafe is 0, expected 1"
        );
    }

    #[test]
    fn apply_safety_detects_excl_get_with_extra_or_missing_groups() {
        // `safety` reports the right `excl=` count; only `excl get` disagrees.
        for (extra, want) in [
            (1, "excl get returned 3 groups, expected 2"),
            (-1, "excl get returned 1 groups, expected 2"),
        ] {
            let (mut c, _dev, _state) = safety_conn(SafetyDevice {
                excl_get_extra: extra,
                ..SafetyDevice::default()
            });
            assert_matches!(
                c.apply_safety(&full_cfg()),
                Err(SdkError::SafetyMismatch(m)) if m == want,
                "extra {extra}"
            );
        }
    }

    #[test]
    fn close_and_drop_send_nothing() {
        let (mut c, dev, _state) = safety_conn(SafetyDevice::default());
        c.apply_safety(&full_cfg()).unwrap();
        let before = dev.commands();
        c.close().unwrap();
        assert_eq!(dev.commands(), before);
        let (c2, dev2, _state2) = safety_conn(SafetyDevice::default());
        drop(c2);
        assert_eq!(dev2.commands(), ["version"]);
    }
}
