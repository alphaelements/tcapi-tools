//! Push event and traffic-log forwarding: SDK channels → Tauri events.

use std::sync::mpsc::Receiver;
use std::sync::Arc;

use pochi_sdk::{PushEvent, TrafficDirection, TrafficHook};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

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

/// Build the traffic hook that mirrors every wire line to `pochi://log`.
pub fn traffic_hook(app: AppHandle) -> TrafficHook {
    Arc::new(move |dir, line: &str| {
        let _ = app.emit(
            "pochi://log",
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
            "pochi://input",
            json!({ "inputs": inputs, "timestampUs": t_us }),
        ),
        PushEvent::PatternDone { loops } => ("pochi://pattern-done", json!({ "loops": loops })),
        PushEvent::PatternTimeout { loops } => {
            ("pochi://pattern-timeout", json!({ "loops": loops }))
        }
        PushEvent::Unknown { raw } => ("pochi://unknown-event", json!({ "raw": raw })),
    }
}

/// Forward push events to the webview until the connection (and with it the
/// sending side of the channel) is dropped.
pub fn spawn_forwarder(app: AppHandle, rx: Receiver<PushEvent>) {
    std::thread::spawn(move || {
        while let Ok(event) = rx.recv() {
            let (name, payload) = route(&event);
            let _ = app.emit(name, payload);
        }
    });
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
        assert_eq!(name, "pochi://input");
        assert_eq!(payload["inputs"], 0x1F00);
        assert_eq!(payload["timestampUs"], 1_234_567);
    }

    #[test]
    fn pattern_done_routes_with_loops() {
        let (name, payload) = route(&PushEvent::PatternDone { loops: 3 });
        assert_eq!(name, "pochi://pattern-done");
        assert_eq!(payload["loops"], 3);
    }

    #[test]
    fn pattern_timeout_routes_with_loops() {
        let (name, payload) = route(&PushEvent::PatternTimeout { loops: 7 });
        assert_eq!(name, "pochi://pattern-timeout");
        assert_eq!(payload["loops"], 7);
    }

    #[test]
    fn unknown_routes_with_raw_line() {
        let (name, payload) = route(&PushEvent::Unknown {
            raw: "WEIRD 1".to_string(),
        });
        assert_eq!(name, "pochi://unknown-event");
        assert_eq!(payload["raw"], "WEIRD 1");
    }

    #[test]
    fn direction_labels_match_frontend_log_styles() {
        assert_eq!(direction_label(TrafficDirection::Sent), "sent");
        assert_eq!(direction_label(TrafficDirection::Received), "received");
        assert_eq!(direction_label(TrafficDirection::Event), "event");
    }
}
