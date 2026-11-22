//! Push event and traffic-log forwarding: SDK channels → Tauri events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tcapi_sdk::{Heartbeat, PushEvent, TrafficDirection, TrafficHook};

/// One line of device traffic for the frontend command log.
#[derive(Debug, Clone, Serialize)]
pub struct LogPayload {
    /// `sent` | `received` | `event` (matches the frontend log styles).
    pub direction: &'static str,
    pub line: String,
}

pub fn direction_label(dir: TrafficDirection) -> &'static str {
    match dir {
        TrafficDirection::Sent => "sent",
        TrafficDirection::Received => "received",
        TrafficDirection::Event => "event",
    }
}

/// Build the traffic hook that mirrors every wire line to `tcapi://log`.
pub fn traffic_hook(app: AppHandle) -> TrafficHook {
    Arc::new(move |dir, line: &str| {
        let _ = app.emit(
            "tcapi://log",
            LogPayload {
                direction: direction_label(dir),
                line: line.to_string(),
            },
        );
    })
}

/// Map one push event to its Tauri event name and JSON payload.
pub fn route(event: &PushEvent) -> (&'static str, Value) {
    match event {
        PushEvent::InputChange { inputs, t_us } => (
            "tcapi://input",
            json!({ "inputs": inputs, "timestampUs": t_us }),
        ),
        PushEvent::PatternDone { loops } => ("tcapi://pattern-done", json!({ "loops": loops })),
        PushEvent::PatternTimeout { loops } => {
            ("tcapi://pattern-timeout", json!({ "loops": loops }))
        }
        PushEvent::Failsafe { cause } => ("tcapi://failsafe", json!({ "cause": cause.as_str() })),
        PushEvent::Unknown { raw } => ("tcapi://unknown-event", json!({ "raw": raw })),
    }
}

/// How often the forwarder checks its stop flag while no event arrives.
const FORWARDER_POLL: Duration = Duration::from_millis(100);

/// Forward push events to the webview until the connection (and with it the
/// sending side of the channel) is dropped or the returned flag is set.
/// Ending the forwarder drops `rx`, which tells the SDK this subscriber is
/// gone.
pub fn spawn_forwarder(app: AppHandle, rx: Receiver<PushEvent>) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    std::thread::spawn({
        let stop = Arc::clone(&stop);
        move || {
            while !stop.load(Ordering::Relaxed) {
                match rx.recv_timeout(FORWARDER_POLL) {
                    Ok(event) => {
                        let (name, payload) = route(&event);
                        let _ = app.emit(name, payload);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        }
    });
    stop
}

/// How often the heartbeat monitor checks its stop flag and the heartbeat.
const HEARTBEAT_POLL: Duration = Duration::from_millis(100);

/// What one look at a running heartbeat found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeartbeatPoll {
    /// Still sending pings.
    Running,
    /// The heartbeat ended with this failure (reported once by the SDK).
    Failed(String),
    /// The heartbeat ended without a failure (the connection was dropped).
    Ended,
}

/// Event name and payload for a heartbeat that stopped on a failure. The
/// device will trip its own watchdog; the UI should say so.
pub fn heartbeat_failed(message: &str) -> (&'static str, Value) {
    ("tcapi://heartbeat-failed", json!({ "message": message }))
}

/// Drive a heartbeat monitor: `poll` until `stop` is set, the heartbeat
/// ends, or it fails. A failure is passed to `on_failure` once, unless a
/// stop was requested meanwhile (a disconnect or reset makes the in-flight
/// ping fail; that is not a heartbeat failure). On return `stop` is set, so
/// the owner sees the monitor as no longer running.
pub fn watch_heartbeat(
    stop: &AtomicBool,
    mut poll: impl FnMut() -> HeartbeatPoll,
    on_failure: impl FnOnce(String),
) {
    while !stop.load(Ordering::Relaxed) {
        match poll() {
            HeartbeatPoll::Running => {}
            HeartbeatPoll::Failed(message) => {
                if !stop.load(Ordering::Relaxed) {
                    on_failure(message);
                }
                break;
            }
            HeartbeatPoll::Ended => break,
        }
    }
    stop.store(true, Ordering::Relaxed);
}

/// Own `heartbeat` on a monitor thread: report its failure as
/// `tcapi://heartbeat-failed`, and stop it (dropping it sends nothing to the
/// device and changes no output) when the returned flag is set.
pub fn spawn_heartbeat_monitor(app: AppHandle, heartbeat: Heartbeat) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    std::thread::spawn({
        let stop = Arc::clone(&stop);
        move || {
            watch_heartbeat(
                &stop,
                || match heartbeat.wait_failure(HEARTBEAT_POLL) {
                    Some(e) => HeartbeatPoll::Failed(e.to_string()),
                    None if heartbeat.is_running() => HeartbeatPoll::Running,
                    None => HeartbeatPoll::Ended,
                },
                |message| {
                    let (name, payload) = heartbeat_failed(&message);
                    // Emitting only fails while the app is shutting down;
                    // nobody is left to tell then.
                    let _ = app.emit(name, payload);
                },
            );
            // Joins the heartbeat thread; an in-flight ping finishes first.
            heartbeat.stop();
        }
    });
    stop
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_change_routes_to_input_event() {
        let (name, payload) = route(&PushEvent::InputChange {
            inputs: 0x1F00,
            t_us: 1_234_567,
        });
        assert_eq!(name, "tcapi://input");
        assert_eq!(payload["inputs"], 0x1F00);
        assert_eq!(payload["timestampUs"], 1_234_567);
    }

    #[test]
    fn pattern_done_routes_with_loops() {
        let (name, payload) = route(&PushEvent::PatternDone { loops: 3 });
        assert_eq!(name, "tcapi://pattern-done");
        assert_eq!(payload["loops"], 3);
    }

    #[test]
    fn failsafe_routes_with_its_cause() {
        let (name, payload) = route(&PushEvent::Failsafe {
            cause: tcapi_sdk::FailsafeCause::Wdog,
        });
        assert_eq!(name, "tcapi://failsafe");
        assert_eq!(payload["cause"], "wdog");
    }

    #[test]
    fn pattern_timeout_routes_with_loops() {
        let (name, payload) = route(&PushEvent::PatternTimeout { loops: 7 });
        assert_eq!(name, "tcapi://pattern-timeout");
        assert_eq!(payload["loops"], 7);
    }

    #[test]
    fn unknown_routes_with_raw_line() {
        let (name, payload) = route(&PushEvent::Unknown {
            raw: "WEIRD 1".to_string(),
        });
        assert_eq!(name, "tcapi://unknown-event");
        assert_eq!(payload["raw"], "WEIRD 1");
    }

    // --- heartbeat monitor ---

    use std::cell::RefCell;

    /// Run `watch_heartbeat` over a scripted poll sequence; returns the
    /// failure messages reported and how many polls were consumed.
    fn run_watch(stop: &AtomicBool, script: Vec<HeartbeatPoll>) -> (Vec<String>, usize) {
        let polls = RefCell::new(script.into_iter());
        let consumed = RefCell::new(0usize);
        let mut reported = Vec::new();
        watch_heartbeat(
            stop,
            || {
                *consumed.borrow_mut() += 1;
                polls.borrow_mut().next().unwrap_or(HeartbeatPoll::Ended)
            },
            |m| reported.push(m),
        );
        (reported, consumed.into_inner())
    }

    #[test]
    fn watch_reports_the_first_failure_once_and_ends() {
        let stop = AtomicBool::new(false);
        let (reported, consumed) = run_watch(
            &stop,
            vec![
                HeartbeatPoll::Running,
                HeartbeatPoll::Failed("ping: timeout".to_string()),
                HeartbeatPoll::Failed("never seen".to_string()),
            ],
        );
        assert_eq!(reported, vec!["ping: timeout".to_string()]);
        assert_eq!(consumed, 2);
        assert!(
            stop.load(Ordering::Relaxed),
            "an ended monitor marks itself stopped"
        );
    }

    #[test]
    fn watch_ends_silently_when_the_heartbeat_ended_without_failure() {
        let stop = AtomicBool::new(false);
        let (reported, _) = run_watch(&stop, vec![HeartbeatPoll::Running, HeartbeatPoll::Ended]);
        assert!(reported.is_empty());
        assert!(stop.load(Ordering::Relaxed));
    }

    #[test]
    fn watch_does_not_poll_once_stopped() {
        let stop = AtomicBool::new(true);
        let (reported, consumed) = run_watch(&stop, vec![HeartbeatPoll::Running]);
        assert!(reported.is_empty());
        assert_eq!(consumed, 0);
    }

    #[test]
    fn watch_ignores_a_failure_that_races_with_a_requested_stop() {
        // The stop request (disconnect, reset) arrives while a ping is in
        // flight; the ping then fails because the link is going away. That
        // is not a heartbeat failure to show the user.
        let stop = AtomicBool::new(false);
        let mut reported = Vec::new();
        watch_heartbeat(
            &stop,
            || {
                stop.store(true, Ordering::Relaxed);
                HeartbeatPoll::Failed("ping: closed".to_string())
            },
            |m| reported.push(m),
        );
        assert!(reported.is_empty());
    }

    #[test]
    fn heartbeat_failure_payload_carries_the_message() {
        let (name, payload) = heartbeat_failed("ping: timeout");
        assert_eq!(name, "tcapi://heartbeat-failed");
        assert_eq!(payload["message"], "ping: timeout");
    }

    #[test]
    fn direction_labels_match_frontend_log_styles() {
        assert_eq!(direction_label(TrafficDirection::Sent), "sent");
        assert_eq!(direction_label(TrafficDirection::Received), "received");
        assert_eq!(direction_label(TrafficDirection::Event), "event");
    }
}
