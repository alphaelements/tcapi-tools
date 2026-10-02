//! Serial transport: line-oriented command/response exchange with push
//! event multiplexing (transport contract R-H1 .. R-H4, R-E2).
//!
//! A background reader thread owns the read half of the port. It splits the
//! byte stream into lines and routes them: push lines (`! ...`) go to the
//! event path, everything else goes to the response queue. Commands are
//! written from the caller's thread and their responses taken from the
//! response queue, so a push event arriving mid-command never corrupts
//! response parsing.
//!
//! # Contract
//!
//! - **One command, one response (R-H1).** A response is a single `OK` /
//!   `ERR` line, or an `OK` header carrying `count=<N>` followed by exactly N
//!   lines. The N lines are read exactly. Leftover lines are never silently
//!   drained to "catch up".
//! - **Resynchronisation (R-H2).** A timeout, an unparseable line or a short
//!   counted response marks the transport *desynchronised*. The next
//!   operation first sends `ping <random u32>` and discards every response
//!   line until `OK pong=<same value>`. If that fails the transport is closed
//!   and every operation reports [`SdkError::Disconnected`].
//! - **Raw (R-H3).** [`Transport::raw`] returns all lines of the response and
//!   refuses `subscribe`.
//! - **Subscription (R-H4).** The SDK owns `subscribe`. The device is
//!   switched on when the first subscriber attaches and off again once the
//!   last one is gone; one device subscription is fanned out to all
//!   subscribers. A dropped receiver is noticed when the reader next fails
//!   to deliver an event to it, so the `subscribe off` is sent lazily, before
//!   the next operation. That `subscribe off` is housekeeping: if it fails the
//!   failure is logged and the operation proceeds (resynchronising first after
//!   a timeout).
//! - **Unknown events (R-E2).** An unknown or malformed push line is logged
//!   to stderr and dropped; it is never delivered and never queued as a
//!   response.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
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

/// Most continuation lines of one counted response the transport accepts.
/// The device sends at most 85 (`ts get`) or a few dozen (`help`); a larger
/// `count=` is a corrupt header, not data to wait for.
const MAX_COUNTED_LINES: u64 = 1024;

/// Command prefix that only the SDK itself may send (R-H4).
const SUBSCRIBE_COMMAND: &str = "subscribe";

type Subscribers = Arc<Mutex<Vec<Sender<PushEvent>>>>;

/// Direction of one logical line on the wire, as seen by a
/// [`TrafficHook`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrafficDirection {
    /// Command line written to the device (without the trailing `\r\n`).
    Sent,
    /// Response line (`OK ...` / `ERR ...` / counted data line).
    Received,
    /// Push event line (`! ...`), delivered from the reader thread.
    Event,
}

/// Observer for every line exchanged with the device (GUI command log,
/// debug tracing). Called synchronously: `Sent`/`Received` from the
/// caller's thread, `Event` from the reader thread — keep it fast.
pub type TrafficHook = Arc<dyn Fn(TrafficDirection, &str) + Send + Sync>;

type HookSlot = Arc<Mutex<Option<TrafficHook>>>;

fn notify_hook(slot: &HookSlot, dir: TrafficDirection, line: &str) {
    let guard = slot.lock().expect("traffic hook poisoned");
    if let Some(hook) = guard.as_ref() {
        hook(dir, line);
    }
}

/// A fresh, unpredictable `u32` for the resync `ping`. `RandomState` is
/// seeded from the OS and yields different keys on every construction, so no
/// extra dependency is needed.
fn random_u32() -> u32 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u8(0);
    // Truncation intended: only the low 32 bits are used as the nonce.
    hasher.finish() as u32
}

/// Line-oriented transport to one device.
pub struct Transport {
    writer: Box<dyn Write + Send>,
    responses: Receiver<String>,
    subscribers: Subscribers,
    hook_slot: HookSlot,
    shutdown: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    timeout: Duration,
    /// The response stream may be out of step with the commands sent.
    desync: bool,
    /// Resync failed (or the device is gone); the transport is unusable.
    closed: bool,
    /// The device-side `subscribe` state as last confirmed by the device.
    device_subscribed: bool,
}

impl Transport {
    /// Open the serial port at `path`, assert DTR (the device sends no
    /// events without it) and start the reader thread.
    pub fn open(path: &str) -> Result<Self> {
        let mut port = serialport::new(path, BAUD_RATE)
            .timeout(READ_POLL_INTERVAL)
            .open()?;
        port.write_data_terminal_ready(true)?;
        Self::from_port(port)
    }

    /// Wrap an already-open port (also used by PTY-based tests). The port is
    /// used as given: the caller asserts DTR on real hardware (a PTY has no
    /// modem lines).
    pub fn from_port(mut port: Box<dyn serialport::SerialPort>) -> Result<Self> {
        port.set_timeout(READ_POLL_INTERVAL)?;
        let read_half = port.try_clone()?;
        Ok(Self::from_io(Box::new(read_half), Box::new(port)))
    }

    /// Build a transport over any byte stream pair. `reader` must return
    /// `ErrorKind::TimedOut` periodically when idle (so the reader thread can
    /// notice shutdown) and `Ok(0)` only at end of stream.
    pub(crate) fn from_io(reader: Box<dyn Read + Send>, writer: Box<dyn Write + Send>) -> Self {
        let (resp_tx, responses) = mpsc::channel();
        let subscribers: Subscribers = Arc::new(Mutex::new(Vec::new()));
        let hook_slot: HookSlot = Arc::new(Mutex::new(None));
        let shutdown = Arc::new(AtomicBool::new(false));

        let handle = std::thread::spawn({
            let subscribers = Arc::clone(&subscribers);
            let hook_slot = Arc::clone(&hook_slot);
            let shutdown = Arc::clone(&shutdown);
            move || reader_loop(reader, resp_tx, subscribers, hook_slot, shutdown)
        });

        Self {
            writer,
            responses,
            subscribers,
            hook_slot,
            shutdown,
            reader: Some(handle),
            timeout: DEFAULT_COMMAND_TIMEOUT,
            desync: false,
            closed: false,
            device_subscribed: false,
        }
    }

    /// Install an observer for every line exchanged with the device.
    /// Replaces any previous hook; `None` removes it.
    pub fn set_traffic_hook(&mut self, hook: Option<TrafficHook>) {
        *self.hook_slot.lock().expect("traffic hook poisoned") = hook;
    }

    /// Set the command response timeout.
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    /// Send a command expecting a single `OK`/`ERR` response line and return
    /// the `OK` data. A counted response is consumed completely but refused
    /// (use [`Transport::command_counted`] for those commands).
    pub fn command(&mut self, cmd: &str) -> Result<String> {
        let lines = self.exchange(cmd)?;
        let data = parse_first(&lines)?;
        if lines.len() > 1 {
            return Err(SdkError::Parse(format!(
                "unexpected counted response to {cmd}: {}",
                lines[0]
            )));
        }
        Ok(data)
    }

    /// Send a command whose response is `OK count=<N> ...` followed by
    /// exactly N data lines (`ts get`). Returns the `OK` data and the N lines.
    pub fn command_counted(&mut self, cmd: &str) -> Result<(String, Vec<String>)> {
        let mut lines = self.exchange(cmd)?;
        let data = parse_first(&lines)?;
        protocol::parse_count_field(&data)?;
        lines.remove(0);
        Ok((data, lines))
    }

    /// Send an arbitrary command and return **every** line of the response
    /// as received (`OK`/`ERR` header and, for a counted response, all N
    /// continuation lines), unparsed. A device `ERR` is a normal return
    /// value here. `subscribe` is refused locally: the SDK owns the device
    /// subscription ([`Transport::subscribe_events`]).
    pub fn raw(&mut self, cmd: &str) -> Result<Vec<String>> {
        let first_word = cmd.split_whitespace().next().unwrap_or_default();
        if first_word.eq_ignore_ascii_case(SUBSCRIBE_COMMAND) {
            return Err(SdkError::InvalidArgument(
                "subscribe is managed by the SDK and cannot be sent as a raw command".into(),
            ));
        }
        self.exchange(cmd)
    }

    /// Attach a push event subscriber. The first subscriber switches the
    /// device subscription on; later ones share it. Every subscriber
    /// receives every event. Dropping the receiver unsubscribes; the device
    /// is switched off once no subscriber is left (see the module docs).
    pub fn subscribe_events(&mut self) -> Result<Receiver<PushEvent>> {
        self.ensure_synced()?;
        let (tx, rx) = mpsc::channel();
        // Register before asking the device so no event slips through
        // between its `OK` and the registration.
        self.subscribers
            .lock()
            .expect("subscribers poisoned")
            .push(tx);
        if !self.device_subscribed {
            let switched_on = self
                .exchange_unsynced("subscribe on")
                .and_then(|lines| parse_first(&lines));
            if let Err(e) = switched_on {
                // Only this call registers subscribers (`&mut self`) and the
                // reader only ever removes dead ones, so ours is the last.
                self.subscribers.lock().expect("subscribers poisoned").pop();
                return Err(e);
            }
            self.device_subscribed = true;
        }
        Ok(rx)
    }

    /// Number of subscribers not yet known to be gone.
    fn live_subscribers(&self) -> usize {
        self.subscribers.lock().expect("subscribers poisoned").len()
    }

    // --- exchange machinery ---

    /// One full command exchange after making sure the stream is in step.
    fn exchange(&mut self, cmd: &str) -> Result<Vec<String>> {
        self.ensure_synced()?;
        self.release_unused_subscription();
        // The lazy `subscribe off` may have desynchronised the stream.
        self.ensure_synced()?;
        self.exchange_unsynced(cmd)
    }

    /// Fail on a closed transport and resynchronise a desynchronised one.
    fn ensure_synced(&mut self) -> Result<()> {
        if self.closed {
            return Err(SdkError::Disconnected);
        }
        if self.desync {
            if self.resync().is_err() {
                self.close();
                return Err(SdkError::Disconnected);
            }
            self.desync = false;
        }
        Ok(())
    }

    /// Switch the device subscription off when its last subscriber is gone.
    ///
    /// This is housekeeping for the benefit of no caller in particular, so a
    /// failure is logged and never becomes the error of the command it
    /// precedes. The device state is then unknown; it is considered off (the
    /// next subscriber sends `subscribe on` again, which is idempotent) so the
    /// off is attempted once, not before every later command. A timeout
    /// leaves the stream desynchronised; the caller resynchronises it before
    /// sending its own command.
    fn release_unused_subscription(&mut self) {
        if !self.device_subscribed || self.live_subscribers() != 0 {
            return;
        }
        let switched_off = self
            .exchange_unsynced("subscribe off")
            .and_then(|lines| parse_first(&lines));
        if let Err(e) = switched_off {
            eprintln!("pochi-sdk: error: releasing the unused device subscription failed: {e}");
        }
        self.device_subscribed = false;
    }

    /// Write `cmd` and read its complete response: the first line, plus N
    /// more when the `OK` header carries `count=<N>`.
    fn exchange_unsynced(&mut self, cmd: &str) -> Result<Vec<String>> {
        self.write_line(cmd)?;
        let first = self.recv_line()?;
        let count = match protocol::parse_response(&first) {
            Ok(Response::Ok(data)) => self.header_count(&data)?,
            Ok(Response::Err(_)) => 0,
            Ok(Response::Push(_)) => {
                // The reader routes push lines to the event path, so this
                // cannot happen; treat it as stream corruption regardless.
                return Err(self.desynchronised(SdkError::Parse(format!(
                    "push line in response position: {first}"
                ))));
            }
            Err(e) => return Err(self.desynchronised(e)),
        };

        let mut lines = Vec::with_capacity(1 + count);
        lines.push(first);
        // Per-line deadline: a slow stream of a large capture must not trip
        // the budget that bounds the header.
        for _ in 0..count {
            lines.push(self.recv_line()?);
        }
        Ok(lines)
    }

    /// Number of continuation lines announced by an `OK` header (0 when it
    /// has no `count=`). A corrupt or absurd count desynchronises.
    fn header_count(&mut self, data: &str) -> Result<usize> {
        if !data.split_whitespace().any(|t| t.starts_with("count=")) {
            return Ok(0);
        }
        let count = protocol::parse_count_field(data).map_err(|e| self.desynchronised(e))?;
        if count > MAX_COUNTED_LINES {
            return Err(self.desynchronised(SdkError::Parse(format!(
                "count={count} exceeds the {MAX_COUNTED_LINES} line limit: {data}"
            ))));
        }
        // Bounded by MAX_COUNTED_LINES above.
        Ok(count as usize)
    }

    /// Mark the stream as out of step and hand `err` back to the caller.
    fn desynchronised(&mut self, err: SdkError) -> SdkError {
        self.desync = true;
        err
    }

    /// `ping <random>` and discard response lines until its `pong`.
    fn resync(&mut self) -> Result<()> {
        let nonce = random_u32();
        self.write_line(&format!("ping {nonce}"))?;
        let deadline = Instant::now() + self.timeout;
        loop {
            let line = self.recv_until(deadline)?;
            let is_our_pong = matches!(
                protocol::parse_response(&line),
                Ok(Response::Ok(data)) if protocol::parse_pong(&data).is_ok_and(|n| n == nonce)
            );
            if is_our_pong {
                return Ok(());
            }
        }
    }

    /// Stop the reader and refuse all further operations.
    fn close(&mut self) {
        self.closed = true;
        self.shutdown.store(true, Ordering::Relaxed);
    }

    fn write_line(&mut self, cmd: &str) -> Result<()> {
        if cmd.contains(['\r', '\n']) {
            return Err(SdkError::InvalidArgument(
                "command contains a line break".into(),
            ));
        }
        if cmd.len() > protocol::MAX_LINE_BYTES {
            return Err(SdkError::InvalidArgument(format!(
                "command is {} bytes, the device accepts at most {}",
                cmd.len(),
                protocol::MAX_LINE_BYTES
            )));
        }
        let line = format!("{cmd}\r\n");
        let result = self
            .writer
            .write_all(line.as_bytes())
            .and_then(|()| self.writer.flush());
        match result {
            Ok(()) => {
                notify_hook(&self.hook_slot, TrafficDirection::Sent, cmd);
                Ok(())
            }
            // A write failure after the reader thread died means the device
            // is gone; report that uniformly instead of a raw I/O error.
            Err(_) if self.reader_exited() => Err(SdkError::Disconnected),
            Err(e) => {
                // Part of the command may have reached the device.
                self.desync = true;
                Err(e.into())
            }
        }
    }

    fn reader_exited(&self) -> bool {
        self.reader.as_ref().is_none_or(|h| h.is_finished())
    }

    /// Next response line within one command timeout. A timeout means the
    /// stream may be out of step.
    fn recv_line(&mut self) -> Result<String> {
        let deadline = Instant::now() + self.timeout;
        let result = self.recv_until(deadline);
        if matches!(result, Err(SdkError::Timeout)) {
            self.desync = true;
        }
        result
    }

    fn recv_until(&self, deadline: Instant) -> Result<String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO);
        match self.responses.recv_timeout(remaining) {
            Ok(line) => Ok(line),
            Err(RecvTimeoutError::Timeout) => Err(SdkError::Timeout),
            Err(RecvTimeoutError::Disconnected) => Err(SdkError::Disconnected),
        }
    }
}

/// The `OK` data of a response whose first line is `lines[0]`; `ERR` maps to
/// its typed error.
fn parse_first(lines: &[String]) -> Result<String> {
    let first = lines
        .first()
        .ok_or_else(|| SdkError::Parse("empty response".into()))?;
    protocol::parse_response(first)?.ok_data()
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(handle) = self.reader.take() {
            // A panicked reader has nothing left to clean up on our side.
            let _ = handle.join();
        }
    }
}

fn reader_loop(
    mut port: Box<dyn Read + Send>,
    resp_tx: Sender<String>,
    subscribers: Subscribers,
    hook_slot: HookSlot,
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
                        notify_hook(&hook_slot, TrafficDirection::Event, trimmed);
                        dispatch_event(&subscribers, trimmed, &payload);
                    } else {
                        notify_hook(&hook_slot, TrafficDirection::Received, trimmed);
                        if resp_tx.send(trimmed.to_string()).is_err() {
                            return; // Transport dropped
                        }
                    }
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break, // fatal I/O error: device gone
        }
    }
    // resp_tx drops here; pending recv calls observe Disconnected.
}

/// Fan one push line out to every live subscriber, pruning the ones whose
/// receiver is gone. Unknown and malformed events are logged and dropped
/// (R-E2): they are neither delivered nor treated as responses.
fn dispatch_event(subscribers: &Subscribers, line: &str, payload: &str) {
    let event = match protocol::parse_push_event(payload) {
        Ok(PushEvent::Unknown { .. }) => {
            eprintln!("pochi-sdk: error: dropping unknown event: {line}");
            return;
        }
        Ok(event) => event,
        Err(err) => {
            eprintln!("pochi-sdk: error: dropping malformed event ({err}): {line}");
            return;
        }
    };
    subscribers
        .lock()
        .expect("subscribers poisoned")
        .retain(|tx| tx.send(event.clone()).is_ok());
}

#[cfg(test)]
mod tests;
