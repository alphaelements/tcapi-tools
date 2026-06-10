//! Serial transport: line-oriented command/response exchange with push
//! event multiplexing.
//!
//! A background reader thread owns the read half of the port. It splits the
//! byte stream into lines and routes them: push lines (`! ...`) go to the
//! event channel, everything else goes to the response channel. Commands are
//! written from the caller's thread and their responses received through the
//! response channel, so a push event arriving mid-command never corrupts
//! response parsing.
//!
//! Two read disciplines exist and must stay separate:
//! - [`Transport::command`] — exactly one response line (`OK`/`ERR`).
//! - [`Transport::command_counted`] — `OK count=N` followed by exactly N
//!   data lines (only `ts get`). Using a counted read on a single-line
//!   command (e.g. `sync count`) would hang until timeout; using a plain
//!   read on `ts get` would leave N lines behind. Never unify them.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::error::{Result, SdkError};
use crate::protocol::{self, Response};
use crate::types::PushEvent;

/// Conventional baud rate. Irrelevant for USB CDC but required by the API.
pub const BAUD_RATE: u32 = 115_200;

/// Default time to wait for a command response.
pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

/// Poll interval of the reader thread (also bounds shutdown latency).
const READ_POLL_INTERVAL: Duration = Duration::from_millis(50);

type EventSlot = Arc<Mutex<Option<Sender<PushEvent>>>>;

/// Line-oriented transport to one device.
pub struct Transport {
    port: Box<dyn serialport::SerialPort>,
    responses: Receiver<String>,
    event_slot: EventSlot,
    shutdown: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    timeout: Duration,
}

impl Transport {
    /// Open the serial port at `path` and start the reader thread.
    pub fn open(path: &str) -> Result<Self> {
        let port = serialport::new(path, BAUD_RATE)
            .timeout(READ_POLL_INTERVAL)
            .open()?;
        Self::from_port(port)
    }

    /// Wrap an already-open port (also used by PTY-based tests).
    pub fn from_port(mut port: Box<dyn serialport::SerialPort>) -> Result<Self> {
        port.set_timeout(READ_POLL_INTERVAL)?;
        let read_half = port.try_clone()?;

        let (resp_tx, responses) = mpsc::channel();
        let event_slot: EventSlot = Arc::new(Mutex::new(None));
        let shutdown = Arc::new(AtomicBool::new(false));

        let reader = std::thread::spawn({
            let event_slot = Arc::clone(&event_slot);
            let shutdown = Arc::clone(&shutdown);
            move || reader_loop(read_half, resp_tx, event_slot, shutdown)
        });

        Ok(Self {
            port,
            responses,
            event_slot,
            shutdown,
            reader: Some(reader),
            timeout: DEFAULT_COMMAND_TIMEOUT,
        })
    }

    /// Set the command response timeout.
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    /// Send a command expecting a single `OK`/`ERR` response line.
    pub fn command(&mut self, cmd: &str) -> Result<String> {
        self.drain_stale_responses();
        self.write_line(cmd)?;
        let deadline = Instant::now() + self.timeout;
        let line = self.recv_response(deadline)?;
        protocol::parse_response(&line)?.ok_data()
    }

    /// Send a command whose response is `OK count=N` followed by exactly N
    /// data lines (`ts get` only). Returns the `OK` data and the N lines.
    pub fn command_counted(&mut self, cmd: &str) -> Result<(String, Vec<String>)> {
        self.drain_stale_responses();
        self.write_line(cmd)?;
        let deadline = Instant::now() + self.timeout;

        let first = self.recv_response(deadline)?;
        let data = protocol::parse_response(&first)?.ok_data()?;
        let count = protocol::parse_count_field(&data)?;

        let mut lines = Vec::with_capacity(count as usize);
        for _ in 0..count {
            lines.push(self.recv_response(deadline)?);
        }
        Ok((data, lines))
    }

    /// Send an arbitrary command and return the raw first response line
    /// (`OK ...` / `ERR ...` as received, unparsed). Forward-compatibility
    /// escape hatch; multi-line responses are not consumed here (stale lines
    /// are discarded before the next command).
    pub fn raw(&mut self, cmd: &str) -> Result<String> {
        self.drain_stale_responses();
        self.write_line(cmd)?;
        let deadline = Instant::now() + self.timeout;
        self.recv_response(deadline)
    }

    /// Install an event subscriber. Returns a receiver yielding push events
    /// as they arrive. A second call replaces the previous subscriber.
    /// Push events arriving with no subscriber installed are discarded.
    pub fn subscribe_events(&mut self) -> Receiver<PushEvent> {
        let (tx, rx) = mpsc::channel();
        *self.event_slot.lock().expect("event slot poisoned") = Some(tx);
        rx
    }

    fn write_line(&mut self, cmd: &str) -> Result<()> {
        let line = format!("{cmd}\r\n");
        let result = self
            .port
            .write_all(line.as_bytes())
            .and_then(|()| self.port.flush());
        match result {
            Ok(()) => Ok(()),
            // A write failure after the reader thread died means the device
            // is gone; report that uniformly instead of a raw I/O error.
            Err(_) if self.reader_exited() => Err(SdkError::Disconnected),
            Err(e) => Err(e.into()),
        }
    }

    fn reader_exited(&self) -> bool {
        self.reader.as_ref().is_none_or(|h| h.is_finished())
    }

    fn recv_response(&mut self, deadline: Instant) -> Result<String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO);
        match self.responses.recv_timeout(remaining) {
            Ok(line) => Ok(line),
            Err(RecvTimeoutError::Timeout) => Err(SdkError::Timeout),
            Err(RecvTimeoutError::Disconnected) => Err(SdkError::Disconnected),
        }
    }

    /// Discard response lines left over from a previous timed-out or raw
    /// exchange so they cannot be mistaken for the next response.
    fn drain_stale_responses(&mut self) {
        while self.responses.try_recv().is_ok() {}
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
    }
}

fn reader_loop(
    mut port: Box<dyn serialport::SerialPort>,
    resp_tx: Sender<String>,
    event_slot: EventSlot,
    shutdown: Arc<AtomicBool>,
) {
    let mut acc: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 256];

    while !shutdown.load(Ordering::Relaxed) {
        match port.read(&mut chunk) {
            Ok(0) => break, // EOF: device gone
            Ok(n) => {
                acc.extend_from_slice(&chunk[..n]);
                while let Some(pos) = acc.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = acc.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line_bytes);
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(Response::Push(payload)) = protocol::parse_response(trimmed) {
                        dispatch_event(&event_slot, &payload);
                    } else if resp_tx.send(trimmed.to_string()).is_err() {
                        return; // Transport dropped
                    }
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break, // fatal I/O error: device gone
        }
    }
    // resp_tx drops here; pending recv_response calls observe Disconnected.
}

fn dispatch_event(event_slot: &EventSlot, payload: &str) {
    let guard = event_slot.lock().expect("event slot poisoned");
    let Some(tx) = guard.as_ref() else {
        return; // no subscriber installed
    };
    // A malformed known-type event is delivered as Unknown rather than
    // dropped: the channel carries PushEvent (not Result), and losing the
    // line silently would hide firmware mismatches.
    let event = protocol::parse_push_event(payload).unwrap_or_else(|err| PushEvent::Unknown {
        raw: format!("{payload} (parse error: {err})"),
    });
    let _ = tx.send(event); // receiver dropped: subscriber went away
}

#[cfg(test)]
mod tests {
    use super::*;
    use serialport::TTYPort;
    use std::io::Write;

    /// PTY-backed transport plus the master end acting as a fake device.
    fn pty_transport() -> (Transport, TTYPort) {
        let (master, slave) = TTYPort::pair().expect("failed to create PTY pair");
        let transport = Transport::from_port(Box::new(slave)).unwrap();
        (transport, master)
    }

    /// Read one command line from the fake-device side.
    fn read_command(master: &mut TTYPort) -> String {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match master.read(&mut byte) {
                Ok(1) => {
                    if byte[0] == b'\n' {
                        return String::from_utf8_lossy(&buf)
                            .trim_end_matches('\r')
                            .to_string();
                    }
                    buf.push(byte[0]);
                }
                _ => continue,
            }
        }
        panic!("no command received within deadline");
    }

    /// Spawn a one-shot responder: reads one command, writes scripted lines.
    fn respond_once(
        mut master: TTYPort,
        expect: &'static str,
        reply: &'static [&'static str],
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let cmd = read_command(&mut master);
            assert_eq!(cmd, expect);
            for line in reply {
                master.write_all(line.as_bytes()).unwrap();
                master.write_all(b"\r\n").unwrap();
            }
            master.flush().unwrap();
            // Keep the master alive briefly so the slave doesn't see EOF
            // before the response is consumed.
            std::thread::sleep(Duration::from_millis(200));
        })
    }

    #[test]
    fn command_ok() {
        let (mut t, master) = pty_transport();
        let responder = respond_once(master, "version", &["OK v0.1.0 proto=1"]);
        let data = t.command("version").unwrap();
        assert_eq!(data, "v0.1.0 proto=1");
        responder.join().unwrap();
    }

    #[test]
    fn command_device_error() {
        let (mut t, master) = pty_transport();
        let responder = respond_once(master, "bogus", &["ERR UNKNOWN_CMD"]);
        let err = t.command("bogus").unwrap_err();
        assert!(matches!(err, SdkError::BadCommand));
        responder.join().unwrap();
    }

    #[test]
    fn command_garbage_response_is_parse_error() {
        let (mut t, master) = pty_transport();
        let responder = respond_once(master, "version", &["WHAT IS THIS"]);
        let err = t.command("version").unwrap_err();
        assert!(matches!(err, SdkError::Parse(_)));
        responder.join().unwrap();
    }

    #[test]
    fn command_timeout() {
        let (mut t, _master) = pty_transport();
        t.set_timeout(Duration::from_millis(200));
        let err = t.command("version").unwrap_err();
        assert!(matches!(err, SdkError::Timeout));
    }

    #[test]
    fn command_push_interleaved_with_response() {
        // A push line arriving before the response must not break parsing.
        let (mut t, master) = pty_transport();
        let events = t.subscribe_events();
        let responder = respond_once(master, "read", &["! INPUT 0x000005 t=111", "OK 0x000003"]);
        let data = t.command("read").unwrap();
        assert_eq!(data, "0x000003");
        let ev = events.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(
            ev,
            PushEvent::InputChange {
                inputs: 5,
                timestamp_us: 111
            }
        );
        responder.join().unwrap();
    }

    #[test]
    fn counted_read_consumes_exactly_n_lines() {
        let (mut t, master) = pty_transport();
        let responder = respond_once(
            master,
            "ts get 256",
            &[
                "OK count=2",
                "  0x00000005 c=1000 p=7 s=1",
                "  0x0000000A c=2000 p=12 s=0",
            ],
        );
        let (data, lines) = t.command_counted("ts get 256").unwrap();
        assert_eq!(data, "count=2");
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("c=1000"));
        responder.join().unwrap();
    }

    #[test]
    fn counted_read_zero_count_reads_no_extra_lines() {
        let (mut t, master) = pty_transport();
        let responder = respond_once(master, "ts get 256", &["OK count=0"]);
        let (data, lines) = t.command_counted("ts get 256").unwrap();
        assert_eq!(data, "count=0");
        assert!(lines.is_empty());
        responder.join().unwrap();
    }

    #[test]
    fn counted_read_err_response() {
        let (mut t, master) = pty_transport();
        let responder = respond_once(master, "ts get 256", &["ERR NOT_ARMED"]);
        let err = t.command_counted("ts get 256").unwrap_err();
        assert!(matches!(err, SdkError::NotArmed));
        responder.join().unwrap();
    }

    #[test]
    fn sync_count_via_plain_command_not_counted() {
        // `sync count` returns `OK count=N` with NO extra lines. The plain
        // command path must return immediately instead of waiting for lines.
        let (mut t, master) = pty_transport();
        let responder = respond_once(master, "sync count", &["OK count=1000000"]);
        let start = Instant::now();
        let data = t.command("sync count").unwrap();
        assert_eq!(data, "count=1000000");
        assert!(start.elapsed() < Duration::from_secs(1));
        responder.join().unwrap();
    }

    #[test]
    fn raw_returns_unparsed_line() {
        let (mut t, master) = pty_transport();
        let responder = respond_once(master, "future cmd", &["OK something new"]);
        let line = t.raw("future cmd").unwrap();
        assert_eq!(line, "OK something new");
        responder.join().unwrap();
    }

    #[test]
    fn raw_returns_err_line_unparsed() {
        let (mut t, master) = pty_transport();
        let responder = respond_once(master, "nope", &["ERR BAD_CMD"]);
        let line = t.raw("nope").unwrap();
        assert_eq!(line, "ERR BAD_CMD");
        responder.join().unwrap();
    }

    #[test]
    fn stale_lines_drained_before_next_command() {
        let (mut t, mut master) = pty_transport();
        // Late response for a command that already timed out.
        master.write_all(b"OK stale leftover\r\n").unwrap();
        master.flush().unwrap();
        std::thread::sleep(Duration::from_millis(150));

        let responder = respond_once(master, "version", &["OK v0.1.0 proto=1"]);
        let data = t.command("version").unwrap();
        assert_eq!(data, "v0.1.0 proto=1");
        responder.join().unwrap();
    }

    #[test]
    fn disconnect_surfaces_as_disconnected() {
        let (mut t, master) = pty_transport();
        drop(master); // device unplugged
        std::thread::sleep(Duration::from_millis(150));
        let err = t.command("version").unwrap_err();
        assert!(matches!(err, SdkError::Disconnected));
    }

    #[test]
    fn push_events_stream() {
        let (mut t, mut master) = pty_transport();
        let events = t.subscribe_events();
        master.write_all(b"! INPUT 0x000001 t=100\r\n").unwrap();
        master.write_all(b"! PATTERN_DONE loops=3\r\n").unwrap();
        master
            .write_all(b"! SYNC_DONE status=ready devnum=1 ts=42\r\n")
            .unwrap();
        master.flush().unwrap();

        let timeout = Duration::from_secs(1);
        assert_eq!(
            events.recv_timeout(timeout).unwrap(),
            PushEvent::InputChange {
                inputs: 1,
                timestamp_us: 100
            }
        );
        assert_eq!(
            events.recv_timeout(timeout).unwrap(),
            PushEvent::PatternDone { loops: 3 }
        );
        assert_eq!(
            events.recv_timeout(timeout).unwrap(),
            PushEvent::SyncDone {
                status: "ready".into(),
                devnum: 1,
                timestamp: 42
            }
        );
    }

    #[test]
    fn malformed_push_delivered_as_unknown() {
        let (mut t, mut master) = pty_transport();
        let events = t.subscribe_events();
        master.write_all(b"! INPUT garbage\r\n").unwrap();
        master.flush().unwrap();
        let ev = events.recv_timeout(Duration::from_secs(1)).unwrap();
        match ev {
            PushEvent::Unknown { raw } => assert!(raw.contains("INPUT garbage")),
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn partial_line_assembled_across_reads() {
        let (mut t, mut master) = pty_transport();
        let responder = std::thread::spawn(move || {
            let cmd = read_command(&mut master);
            assert_eq!(cmd, "version");
            master.write_all(b"OK v0.").unwrap();
            master.flush().unwrap();
            std::thread::sleep(Duration::from_millis(100));
            master.write_all(b"1.0 proto=1\r\n").unwrap();
            master.flush().unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let data = t.command("version").unwrap();
        assert_eq!(data, "v0.1.0 proto=1");
        responder.join().unwrap();
    }
}
