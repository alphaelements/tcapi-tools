//! Shared backend state: the single active device connection.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tcapi_sdk::{Connection, DeviceInfo};

/// Backend state behind the Tauri-managed handle. One connection at a time;
/// `device_info` mirrors the connected device for status queries.
#[derive(Default)]
pub struct AppInner {
    pub connection: Option<Connection>,
    pub device_info: Option<DeviceInfo>,
    /// Stop flag of the push-event forwarder; present while the UI is
    /// subscribed. Dropping the forwarder's receiver is how the SDK learns
    /// that the device subscription is no longer needed.
    pub event_stop: Option<Arc<AtomicBool>>,
    /// Stop flag of the watchdog heartbeat monitor; present once a heartbeat
    /// was started for the current connection. The monitor also sets it
    /// when the heartbeat ends on its own.
    pub heartbeat_stop: Option<Arc<AtomicBool>>,
}

impl AppInner {
    /// Stop forwarding push events (no-op when not subscribed).
    pub fn stop_events(&mut self) {
        if let Some(stop) = self.event_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }

    /// Stop the watchdog heartbeat (no-op when none runs). Ending a
    /// heartbeat sends nothing to the device and changes no output: the
    /// device trips its own watchdog `timeout` after the last answer.
    pub fn stop_heartbeat(&mut self) {
        if let Some(stop) = self.heartbeat_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }

    /// Drop the connection and everything bound to it (event forwarder,
    /// heartbeat). Closing the port sends no command and changes no output.
    pub fn release_connection(&mut self) {
        self.stop_events();
        self.stop_heartbeat();
        self.connection = None;
        self.device_info = None;
    }

    /// Borrow the active connection or fail with the message the frontend
    /// shows verbatim.
    pub fn conn(&mut self) -> Result<&mut Connection, String> {
        self.connection
            .as_mut()
            .ok_or_else(|| "Not connected".to_string())
    }
}

/// Cloneable handle shared between Tauri commands and worker threads.
pub type SharedState = Arc<Mutex<AppInner>>;

pub fn lock(state: &SharedState) -> Result<MutexGuard<'_, AppInner>, String> {
    state
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))
}

/// Run a blocking closure against the shared state on the blocking thread
/// pool. Serial I/O takes up to the command timeout (2 s), which must not
/// stall the async runtime driving the UI.
pub async fn with_state<T, F>(state: SharedState, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut AppInner) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut inner = lock(&state)?;
        f(&mut inner)
    })
    .await
    .map_err(|e| format!("blocking task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conn_when_disconnected_is_an_error() {
        let mut inner = AppInner::default();
        assert_eq!(inner.conn().err(), Some("Not connected".to_string()));
    }

    #[test]
    fn stop_heartbeat_sets_the_flag_and_forgets_it() {
        let stop = Arc::new(AtomicBool::new(false));
        let mut inner = AppInner {
            heartbeat_stop: Some(Arc::clone(&stop)),
            ..AppInner::default()
        };
        inner.stop_heartbeat();
        assert!(stop.load(Ordering::Relaxed));
        assert!(inner.heartbeat_stop.is_none());
    }

    #[test]
    fn stop_heartbeat_without_one_is_a_no_op() {
        let mut inner = AppInner::default();
        inner.stop_heartbeat();
        assert!(inner.heartbeat_stop.is_none());
    }

    #[test]
    fn release_connection_stops_forwarder_and_heartbeat() {
        let events = Arc::new(AtomicBool::new(false));
        let beat = Arc::new(AtomicBool::new(false));
        let mut inner = AppInner {
            event_stop: Some(Arc::clone(&events)),
            heartbeat_stop: Some(Arc::clone(&beat)),
            ..AppInner::default()
        };
        inner.release_connection();
        assert!(events.load(Ordering::Relaxed));
        assert!(beat.load(Ordering::Relaxed));
        assert!(inner.connection.is_none() && inner.device_info.is_none());
    }
}
