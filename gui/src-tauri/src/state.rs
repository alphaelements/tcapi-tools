//! Shared backend state: the single active device connection.

use std::sync::{Arc, Mutex, MutexGuard};

use pochi_sdk::{Connection, DeviceInfo};

/// Backend state behind the Tauri-managed handle. One connection at a time;
/// `device_info` mirrors the connected device for status queries.
#[derive(Default)]
pub struct AppInner {
    pub connection: Option<Connection>,
    pub device_info: Option<DeviceInfo>,
}

impl AppInner {
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
}
