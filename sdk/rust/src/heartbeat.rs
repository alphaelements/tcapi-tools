//! Watchdog heartbeat helper (protocol-reference.md section 4, "Safety").
//!
//! The device trips its watchdog when it sees no `OK` answer for the timeout
//! given to `wdog`. Whoever enables the watchdog must keep the device busy:
//! [`crate::Connection::start_heartbeat`] starts a dedicated thread that
//! sends `ping <n>` periodically. The rules, shared by every SDK
//! (docs/sdk-api-design.md, "Heartbeat"):
//!
//! - **Period** = `timeout / 4`, at most 1 s ([`heartbeat_period`]).
//! - **Serialised.** A heartbeat `ping` is a normal command exchange: it
//!   takes the connection for the whole request/response, so it is never
//!   written between another command and its response, nor inside a counted
//!   response.
//! - **A failure is reported once and not retried.** The first failed `ping`
//!   (timeout, `ERR`, wrong `pong`, disconnect) is delivered through
//!   [`Heartbeat::try_failure`] / [`Heartbeat::wait_failure`] and the thread
//!   ends. It does not try again and does not repair anything: the device
//!   will trip its watchdog, which is the safe outcome.
//! - **Closing changes nothing.** Dropping the connection, dropping or
//!   stopping the heartbeat sends no command and changes no output. Without
//!   a heartbeat the device trips `timeout` after the last `OK`.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::error::{Result, SdkError};
use crate::transport::{SharedTransport, WeakTransport};
use crate::types::{WDOG_MAX_MS, WDOG_MIN_MS};

/// Longest heartbeat period.
const MAX_PERIOD: Duration = Duration::from_secs(1);

/// The heartbeat period for a watchdog timeout: `timeout / 4`, at most 1 s.
/// `timeout_ms` must be a value `wdog` accepts for an enabled watchdog
/// (`100..=10000`); `0` (disabled) needs no heartbeat and is refused.
pub fn heartbeat_period(timeout_ms: u32) -> Result<Duration> {
    if !(WDOG_MIN_MS..=WDOG_MAX_MS).contains(&timeout_ms) {
        return Err(SdkError::InvalidArgument(format!(
            "heartbeat needs an enabled watchdog timeout between {WDOG_MIN_MS} and {WDOG_MAX_MS} ms, got {timeout_ms}"
        )));
    }
    Ok(Duration::from_millis(u64::from(timeout_ms / 4)).min(MAX_PERIOD))
}

/// A running heartbeat. Dropping it (or [`Heartbeat::stop`]) ends the thread;
/// that sends nothing to the device, so the watchdog trips `timeout` after
/// the last answered command unless something else keeps it fed.
pub struct Heartbeat {
    period: Duration,
    stop: Option<Sender<()>>,
    failures: Receiver<SdkError>,
    thread: Option<JoinHandle<()>>,
}

/// Start the heartbeat thread for the connection behind `transport`.
pub(crate) fn start(transport: &SharedTransport, timeout_ms: u32) -> Result<Heartbeat> {
    let period = heartbeat_period(timeout_ms)?;
    let (stop, stop_rx) = mpsc::channel();
    let (failure_tx, failures) = mpsc::channel();
    let weak = transport.downgrade();
    let thread = std::thread::spawn(move || run(&weak, period, &stop_rx, &failure_tx));
    Ok(Heartbeat {
        period,
        stop: Some(stop),
        failures,
        thread: Some(thread),
    })
}

/// The heartbeat thread: wait one period, ping, repeat. Ends when stopped,
/// when the connection is gone, or after reporting the first failure.
fn run(weak: &WeakTransport, period: Duration, stop: &Receiver<()>, failure: &Sender<SdkError>) {
    let mut value: u32 = 0;
    loop {
        match stop.recv_timeout(period) {
            Err(RecvTimeoutError::Timeout) => {}
            // A stop request, or the Heartbeat handle is gone.
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
        }
        // The connection was dropped: nothing to keep alive, not a failure.
        let Some(transport) = weak.upgrade() else {
            return;
        };
        if let Err(e) = transport.ping(value) {
            // The receiver may already be dropped together with the handle;
            // then nobody is left to be told.
            let _ = failure.send(e);
            return;
        }
        value = value.wrapping_add(1);
    }
}

impl std::fmt::Debug for Heartbeat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Heartbeat")
            .field("period", &self.period)
            .field("running", &self.is_running())
            .finish()
    }
}

impl Heartbeat {
    /// The interval between pings.
    pub fn period(&self) -> Duration {
        self.period
    }

    /// True while the thread is sending pings (false after a failure, after
    /// the connection was dropped, and after [`Heartbeat::stop`]).
    pub fn is_running(&self) -> bool {
        self.thread.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// The failure that ended the heartbeat, if any (non-blocking). It is
    /// delivered once.
    pub fn try_failure(&self) -> Option<SdkError> {
        self.failures.try_recv().ok()
    }

    /// Wait up to `timeout` for the failure that ends the heartbeat.
    pub fn wait_failure(&self, timeout: Duration) -> Option<SdkError> {
        self.failures.recv_timeout(timeout).ok()
    }

    /// Stop sending pings and wait for the thread to end. Sends nothing to
    /// the device. An exchange in progress is finished first (at most one
    /// command timeout).
    pub fn stop(self) {
        drop(self);
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        // Dropping the sender wakes the thread out of its wait.
        self.stop.take();
        if let Some(thread) = self.thread.take() {
            // A panicked heartbeat thread has nothing left to clean up.
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::Connection;
    use crate::testutil::{pong_for, FakeDevice};
    use crate::transport::Transport;
    use assert_matches::assert_matches;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    /// A connection to a device that answers `version`, `ping`, `help` (a
    /// counted response) and whatever `extra` handles.
    fn connect(
        extra: impl Fn(&str) -> Option<Vec<String>> + Send + 'static,
    ) -> (Connection, FakeDevice) {
        let (reader, writer, dev) = FakeDevice::spawn(move |cmd| {
            if cmd == "version" {
                return vec!["OK fw=0.1.3 proto=2".to_string()];
            }
            if cmd == "help" {
                return vec![
                    "OK count=2".to_string(),
                    "  version  Get firmware version".to_string(),
                    "  help  Show this help".to_string(),
                ];
            }
            if let Some(pong) = pong_for(cmd) {
                return pong;
            }
            extra(cmd).unwrap_or_else(|| vec!["ERR UNKNOWN_CMD".to_string()])
        });
        let mut transport = Transport::from_io(Box::new(reader), Box::new(writer));
        transport.set_timeout(Duration::from_millis(300));
        (
            Connection::establish(transport, "fake".into()).unwrap(),
            dev,
        )
    }

    fn pings(dev: &FakeDevice) -> Vec<String> {
        dev.commands()
            .into_iter()
            .filter(|c| c.starts_with("ping "))
            .collect()
    }

    #[test]
    fn the_period_is_a_quarter_of_the_timeout_capped_at_one_second() {
        for (timeout_ms, ms) in [
            (100, 25),
            (101, 25),
            (400, 100),
            (3999, 999),
            (4000, 1000),
            (4001, 1000),
            (10_000, 1000),
        ] {
            assert_eq!(
                heartbeat_period(timeout_ms).unwrap(),
                Duration::from_millis(ms),
                "timeout {timeout_ms}"
            );
        }
    }

    #[test]
    fn a_disabled_or_out_of_range_timeout_has_no_heartbeat() {
        for bad in [0, 1, 99, 10_001, u32::MAX] {
            assert_matches!(
                heartbeat_period(bad),
                Err(SdkError::InvalidArgument(_)),
                "{bad}"
            );
        }
        let (mut conn, dev) = connect(|_| None);
        assert_matches!(conn.start_heartbeat(0), Err(SdkError::InvalidArgument(_)));
        assert_eq!(dev.commands(), ["version"]);
    }

    #[test]
    fn pings_go_out_every_period_with_distinct_values_until_stopped() {
        let (mut conn, dev) = connect(|_| None);
        let hb = conn.start_heartbeat(100).unwrap();
        assert_eq!(hb.period(), Duration::from_millis(25));
        std::thread::sleep(Duration::from_millis(300));
        assert!(hb.is_running());
        assert!(hb.try_failure().is_none());
        hb.stop();

        let sent = pings(&dev);
        assert!(sent.len() >= 4, "expected a steady stream, got {sent:?}");
        // Every ping is distinct: a stale answer cannot satisfy a later one.
        let mut unique = sent.clone();
        unique.dedup();
        assert_eq!(unique, sent);
        assert_eq!(sent[0], "ping 0");
        // Stopped: nothing more arrives.
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(pings(&dev).len(), sent.len());
    }

    #[test]
    fn a_failure_is_reported_once_and_never_retried() {
        let answered = Arc::new(AtomicUsize::new(0));
        let (reader, writer, dev) = FakeDevice::spawn({
            let answered = Arc::clone(&answered);
            move |cmd| {
                if cmd == "version" {
                    return vec!["OK fw=0.1.3 proto=2".to_string()];
                }
                // The second ping fails, every later one would succeed.
                if cmd.starts_with("ping ") && answered.fetch_add(1, Ordering::SeqCst) == 1 {
                    return vec!["ERR BUSY".to_string()];
                }
                pong_for(cmd).unwrap_or_default()
            }
        });
        let transport = Transport::from_io(Box::new(reader), Box::new(writer));
        let mut conn = Connection::establish(transport, "fake".into()).unwrap();
        let hb = conn.start_heartbeat(100).unwrap();

        let failure = hb.wait_failure(Duration::from_secs(2));
        assert_matches!(failure, Some(SdkError::Busy));
        // Reported once.
        assert!(hb.try_failure().is_none());
        // Many periods later: no third ping, and the thread has ended.
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(pings(&dev).len(), 2, "{:?}", dev.commands());
        assert!(!hb.is_running());
    }

    #[test]
    fn a_silent_device_fails_the_heartbeat_with_a_timeout() {
        let (reader, writer, _dev) = FakeDevice::spawn(|cmd| match cmd {
            "version" => vec!["OK fw=0.1.3 proto=2".to_string()],
            _ => vec![],
        });
        let mut transport = Transport::from_io(Box::new(reader), Box::new(writer));
        transport.set_timeout(Duration::from_millis(60));
        let mut conn = Connection::establish(transport, "fake".into()).unwrap();
        let hb = conn.start_heartbeat(100).unwrap();
        assert_matches!(
            hb.wait_failure(Duration::from_secs(2)),
            Some(SdkError::Timeout)
        );
    }

    #[test]
    fn commands_from_the_caller_are_never_mixed_with_heartbeat_pings() {
        let (mut conn, dev) = connect(|_| None);
        let hb = conn.start_heartbeat(100).unwrap();
        // A counted response and plain responses, hundreds of times while the
        // heartbeat fires every 25 ms: every one must get its own answer.
        let end = Instant::now() + Duration::from_millis(400);
        let mut n = 0u32;
        while Instant::now() < end {
            assert_eq!(conn.help().unwrap().len(), 2);
            assert_eq!(conn.ping(1_000_000 + n).unwrap(), 1_000_000 + n);
            n += 1;
        }
        assert!(n > 10);
        assert!(hb.try_failure().is_none(), "heartbeat saw a bad exchange");
        assert!(hb.is_running());
        // The heartbeat did run meanwhile.
        let heartbeat_pings = pings(&dev)
            .iter()
            .filter(|p| p["ping ".len()..].parse::<u32>().unwrap() < 1_000_000)
            .count();
        assert!(heartbeat_pings >= 4, "{:?}", pings(&dev));
    }

    #[test]
    fn dropping_the_connection_ends_the_heartbeat_without_any_command() {
        let (mut conn, dev) = connect(|_| None);
        let hb = conn.start_heartbeat(100).unwrap();
        std::thread::sleep(Duration::from_millis(80));
        drop(conn);
        // The thread notices the dropped connection at its next tick.
        let deadline = Instant::now() + Duration::from_secs(2);
        while hb.is_running() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!hb.is_running());
        assert!(
            hb.try_failure().is_none(),
            "a dropped connection is not a failure"
        );
        hb.stop();
        // Only the handshake and pings: no write, no outputs reset, no wdog.
        assert!(
            dev.commands()
                .iter()
                .all(|c| c == "version" || c.starts_with("ping ")),
            "{:?}",
            dev.commands()
        );
    }

    #[test]
    fn stopping_or_closing_sends_no_command() {
        let (mut conn, dev) = connect(|_| None);
        let hb = conn.start_heartbeat(100).unwrap();
        std::thread::sleep(Duration::from_millis(60));
        hb.stop();
        conn.close().unwrap();
        assert!(
            dev.commands()
                .iter()
                .all(|c| c == "version" || c.starts_with("ping ")),
            "{:?}",
            dev.commands()
        );
    }
}
