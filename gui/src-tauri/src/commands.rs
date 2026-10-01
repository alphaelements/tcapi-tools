//! Tauri command surface (`docs/gui-feature-spec.md` §9): thin typed
//! wrappers over `pochi-sdk` calls against the shared connection.

use pochi_sdk::reconcile::{self, SourceEvent};
use pochi_sdk::{
    Capabilities, Connection, DeviceInfo, EdgeMode, IoState, PatternMode, PatternStatus,
    PatternStep, PinMap, TimestampResult, VersionInfo,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::events::{self, LogPayload};
use crate::state::{with_state, SharedState};

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// --- discovery and connection ---

#[tauri::command]
pub async fn discover(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<Vec<DeviceInfo>, String> {
    let shared = state.inner().clone();
    with_state(shared, move |_| {
        let found = pochi_sdk::discover_detailed().map_err(err)?;
        // Matching ports that failed to probe (old firmware, busy port)
        // surface in the command log instead of vanishing silently.
        for failure in &found.failures {
            let _ = app.emit(
                "pochi://log",
                LogPayload {
                    direction: "error",
                    line: format!("scan {}: {}", failure.port, failure.error),
                },
            );
        }
        Ok(found.devices)
    })
    .await
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, SharedState>,
    port: String,
) -> Result<DeviceInfo, String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        // Release any previous connection first: the port is opened
        // exclusively, so a stale handle (e.g. after a webview reload)
        // would make reopening fail with EBUSY.
        inner.connection = None;
        inner.device_info = None;
        let mut conn = Connection::open(&port).map_err(err)?;
        conn.set_traffic_hook(Some(events::traffic_hook(app.clone())));
        let rx = conn.subscribe_events();
        events::spawn_forwarder(app, rx);
        let info = conn.info().map_err(err)?;
        inner.connection = Some(conn);
        inner.device_info = Some(info.clone());
        Ok(info)
    })
    .await
}

#[tauri::command]
pub async fn disconnect(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| {
        // Dropping the connection closes the port and stops the forwarder.
        inner.connection = None;
        inner.device_info = None;
        Ok(())
    })
    .await
}

// --- device information ---

#[tauri::command]
pub async fn get_version(state: State<'_, SharedState>) -> Result<VersionInfo, String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.version().map_err(err)).await
}

#[tauri::command]
pub async fn get_caps(state: State<'_, SharedState>) -> Result<Capabilities, String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.caps().map_err(err)).await
}

#[tauri::command]
pub async fn get_info(state: State<'_, SharedState>) -> Result<DeviceInfo, String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.info().map_err(err)).await
}

#[tauri::command]
pub async fn set_device_number(state: State<'_, SharedState>, n: u8) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        inner.conn()?.set_device_number(n).map_err(err)
    })
    .await
}

// --- digital I/O ---

#[tauri::command]
pub async fn read_inputs(state: State<'_, SharedState>) -> Result<u32, String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.read().map_err(err)).await
}

#[tauri::command]
pub async fn write_outputs(
    state: State<'_, SharedState>,
    values: u32,
    mask: u32,
) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        inner.conn()?.write(values, mask).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn read_state(state: State<'_, SharedState>) -> Result<IoState, String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.state().map_err(err)).await
}

#[tauri::command]
pub async fn subscribe(state: State<'_, SharedState>, enable: bool) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        inner.conn()?.subscribe(enable).map_err(err)
    })
    .await
}

// --- pin map ---

#[tauri::command]
pub async fn map_get(state: State<'_, SharedState>) -> Result<PinMap, String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.map_get().map_err(err)).await
}

#[tauri::command]
pub async fn map_set(state: State<'_, SharedState>, map: PinMap) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        inner.conn()?.map_set(&map).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn map_save(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.map_save().map_err(err)).await
}

#[tauri::command]
pub async fn map_default(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.map_default().map_err(err)).await
}

// --- pattern ---

#[tauri::command]
pub async fn pattern_load(
    state: State<'_, SharedState>,
    steps: Vec<PatternStep>,
) -> Result<u16, String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        inner.conn()?.pattern_load(&steps).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn pattern_run(
    state: State<'_, SharedState>,
    mode: PatternMode,
    repeat: u16,
) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        inner.conn()?.pattern_run(mode, repeat).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn pattern_stop(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.pattern_stop().map_err(err)).await
}

#[tauri::command]
pub async fn pattern_status(state: State<'_, SharedState>) -> Result<PatternStatus, String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.pattern_status().map_err(err)).await
}

/// `pattern reset` — pattern engine soft reset (FW v0.1.3+, `FEAT_RESET`).
/// Lighter than `system_reset`: USB stays up, so the GUI keeps its open
/// connection.
#[tauri::command]
pub async fn pattern_reset(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.pattern_reset().map_err(err)).await
}

/// `reset` — full chip soft reset (FW v0.1.3+, `FEAT_RESET`). USB
/// re-enumerates, so the connection is closed afterwards; the frontend
/// must rediscover and reconnect.
#[tauri::command]
pub async fn system_reset(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| {
        let conn = inner
            .connection
            .take()
            .ok_or_else(|| "no device connected".to_string())?;
        inner.device_info = None;
        conn.system_reset().map_err(err)
    })
    .await
}

/// `bootsel` — reboot into BOOTSEL mass-storage mode for UF2 reflash
/// (FW v0.1.3+, `FEAT_RESET`). USB re-enumerates as a mass-storage device,
/// so the connection is closed and the frontend must not try to reopen.
#[tauri::command]
pub async fn bootsel_reset(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| {
        let conn = inner
            .connection
            .take()
            .ok_or_else(|| "no device connected".to_string())?;
        inner.device_info = None;
        conn.bootsel_reset().map_err(err)
    })
    .await
}

// --- timestamp ---

#[tauri::command]
pub async fn ts_arm(
    state: State<'_, SharedState>,
    mask: u32,
    mode: EdgeMode,
) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        inner.conn()?.ts_arm(mask, mode).map_err(err)
    })
    .await
}

/// One timestamp row for the viewer; `timestamp_ns` is reconciled when the
/// result-level `reconciled` flag is set and this row's flag marks an
/// actual adjustment.
#[derive(Debug, Clone, Serialize)]
pub struct TsRow {
    pub inputs: u32,
    pub raw_count: u32,
    pub raw_phase: u8,
    pub sync_active: bool,
    pub timestamp_ns: i64,
    pub reconciled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TsResultPayload {
    pub events: Vec<TsRow>,
    pub reconciled: bool,
    /// Device-side capture buffer overflowed; events were dropped.
    pub overflow: bool,
}

fn as_is_rows(result: &TimestampResult) -> Vec<TsRow> {
    result
        .events
        .iter()
        .map(|e| TsRow {
            inputs: e.inputs,
            raw_count: e.raw_count,
            raw_phase: e.raw_phase,
            sync_active: e.sync_active,
            timestamp_ns: reconcile::as_is_ns(e.raw_count, e.raw_phase),
            reconciled: false,
        })
        .collect()
}

#[tauri::command]
pub async fn ts_get(
    state: State<'_, SharedState>,
    max_events: u16,
) -> Result<TsResultPayload, String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        let result = inner.conn()?.ts_get(max_events).map_err(err)?;
        Ok(TsResultPayload {
            events: as_is_rows(&result),
            reconciled: false,
            overflow: result.overflow,
        })
    })
    .await
}

#[tauri::command]
pub async fn ts_get_reconciled(
    state: State<'_, SharedState>,
    max_events: u16,
) -> Result<TsResultPayload, String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        let result = inner.conn()?.ts_get(max_events).map_err(err)?;
        Ok(reconcile_rows(&result))
    })
    .await
}

/// Apply host-side straddle reconciliation to a raw capture, preserving
/// the device's event order.
fn reconcile_rows(result: &TimestampResult) -> TsResultPayload {
    let mut rows = as_is_rows(result);

    let source_events: Vec<SourceEvent> = result
        .events
        .iter()
        .map(|e| SourceEvent {
            device: "local".to_string(),
            channel: String::new(),
            inputs: format!("{:#08x}", e.inputs),
            raw_count: e.raw_count,
            raw_phase: e.raw_phase,
            sync_active: e.sync_active,
        })
        .collect();

    // group_events processes events sorted by (raw_count, raw_phase) and
    // emits groups in that order; sorting indices with the same stable key
    // recovers the original positions for the flattened group output.
    let mut order: Vec<usize> = (0..result.events.len()).collect();
    order.sort_by_key(|&i| (result.events[i].raw_count, result.events[i].raw_phase));

    let groups = reconcile::group_events(&source_events);
    let mut sorted_pos = 0usize;
    for group in &groups {
        for ns in &group.reconciled_ns {
            let original = order[sorted_pos];
            rows[original].reconciled = group.reconciled && *ns != rows[original].timestamp_ns;
            rows[original].timestamp_ns = *ns;
            sorted_pos += 1;
        }
    }

    TsResultPayload {
        events: rows,
        reconciled: true,
        overflow: result.overflow,
    }
}

#[tauri::command]
pub async fn ts_disarm(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.ts_disarm().map_err(err)).await
}

// --- sync ---

#[tauri::command]
pub async fn sync_arm(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.sync_arm().map_err(err)).await
}

#[tauri::command]
pub async fn sync_master(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.sync_master().map_err(err)).await
}

#[tauri::command]
pub async fn sync_start(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.sync_start().map_err(err)).await
}

#[tauri::command]
pub async fn sync_stop(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.sync_stop().map_err(err)).await
}

#[tauri::command]
pub async fn sync_count(state: State<'_, SharedState>) -> Result<u64, String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.sync_count().map_err(err)).await
}

#[tauri::command]
pub async fn sync_disarm(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.sync_disarm().map_err(err)).await
}

// --- utility ---

#[tauri::command]
pub async fn raw_command(state: State<'_, SharedState>, text: String) -> Result<String, String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| inner.conn()?.raw(&text).map_err(err)).await
}

/// Write export payloads (CSV/JSON built by the frontend) to a path chosen
/// via the save dialog.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, contents).map_err(err))
        .await
        .map_err(|e| format!("blocking task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use pochi_sdk::TimestampEvent;

    // --- reconcile_rows ---

    fn ev(raw_count: u32, raw_phase: u8) -> TimestampEvent {
        TimestampEvent {
            inputs: 0x100,
            raw_count,
            raw_phase,
            sync_active: true,
        }
    }

    #[test]
    fn reconcile_rows_marks_adjusted_events() {
        // Straddle pair: same phase, counts 1 apart — count-1 on the second
        // event collapses both to one instant, so exactly one row moves.
        let result = TimestampResult {
            events: vec![ev(1000, 24), ev(1001, 24)],
            reconciled: false,
            overflow: false,
        };
        let payload = reconcile_rows(&result);
        assert!(payload.reconciled);
        assert_eq!(payload.events.len(), 2);
        let adjusted: Vec<bool> = payload.events.iter().map(|r| r.reconciled).collect();
        assert!(adjusted.contains(&true));
    }

    #[test]
    fn reconcile_rows_keeps_isolated_events_as_is() {
        let result = TimestampResult {
            events: vec![ev(1000, 5), ev(5000, 9)],
            reconciled: false,
            overflow: false,
        };
        let payload = reconcile_rows(&result);
        assert!(payload.events.iter().all(|r| !r.reconciled));
        assert_eq!(payload.events[0].timestamp_ns, reconcile::as_is_ns(1000, 5));
    }

    #[test]
    fn reconcile_rows_preserves_device_order() {
        // Events arrive out of count order; rows must stay in arrival order.
        let result = TimestampResult {
            events: vec![ev(5000, 9), ev(1000, 5)],
            reconciled: false,
            overflow: false,
        };
        let payload = reconcile_rows(&result);
        assert_eq!(payload.events[0].raw_count, 5000);
        assert_eq!(payload.events[1].raw_count, 1000);
    }

    #[test]
    fn reconcile_rows_empty_input() {
        let result = TimestampResult {
            events: vec![],
            reconciled: false,
            overflow: false,
        };
        let payload = reconcile_rows(&result);
        assert!(payload.events.is_empty());
        assert!(payload.reconciled);
    }

    #[test]
    fn reconcile_rows_propagates_overflow() {
        let result = TimestampResult {
            events: vec![ev(1000, 5)],
            reconciled: false,
            overflow: true,
        };
        let payload = reconcile_rows(&result);
        assert!(payload.overflow);
    }
}
