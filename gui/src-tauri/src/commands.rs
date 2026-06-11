//! Tauri command surface (`docs/gui-feature-spec.md` §9): thin typed
//! wrappers over `pochi-sdk` calls against the shared connection.

use pochi_sdk::reconcile::{self, SourceEvent};
use pochi_sdk::{
    toml_config, Capabilities, Connection, DeviceInfo, EdgeMode, IoState, PatternMode,
    PatternStatus, PatternStep, PinMap, PullMode, TimestampResult, VersionInfo,
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
pub async fn map_set_hex(state: State<'_, SharedState>, hex: String) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        inner.conn()?.map_set_hex(&hex).map_err(err)
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

/// Parse a map TOML file into a [`PinMap`] without touching the device;
/// the frontend reviews it and applies via `map_set`. Extended fields
/// (out_default, polarities) are not represented in `PinMap`.
#[tauri::command]
pub async fn map_load_toml(path: String) -> Result<PinMap, String> {
    let toml_str = std::fs::read_to_string(&path).map_err(err)?;
    let hex = toml_config::map_toml_to_hex(&toml_str).map_err(err)?;
    pin_map_from_hex(&hex)
}

/// Decode the 48-char `map set` hex blob (bytes: version, out_base,
/// out_count, in_base, in_count, pull, flags, ...) back into a [`PinMap`].
fn pin_map_from_hex(hex: &str) -> Result<PinMap, String> {
    if hex.len() < 14 || !hex.is_char_boundary(14) {
        return Err(format!("map hex too short: {} chars", hex.len()));
    }
    let mut bytes = [0u8; 7];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|e| format!("invalid map hex at byte {i}: {e}"))?;
    }
    let pull = match bytes[5] {
        0 => PullMode::None,
        1 => PullMode::Up,
        2 => PullMode::Down,
        other => return Err(format!("invalid pull code: {other}")),
    };
    Ok(PinMap {
        version: bytes[0],
        out_base: bytes[1],
        out_count: bytes[2],
        in_base: bytes[3],
        in_count: bytes[4],
        pull,
        flags: bytes[6],
    })
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

/// Steps parsed from a pattern TOML file plus the device's accepted count,
/// so the editor can show what was uploaded.
#[derive(Debug, Clone, Serialize)]
pub struct PatternTomlPayload {
    pub steps: Vec<PatternStep>,
    pub accepted: u16,
}

#[tauri::command]
pub async fn pattern_load_toml(
    state: State<'_, SharedState>,
    path: String,
) -> Result<PatternTomlPayload, String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        let toml_str = std::fs::read_to_string(&path).map_err(err)?;
        let steps = toml_config::pattern_toml_to_steps(&toml_str).map_err(err)?;
        let accepted = inner.conn()?.pattern_load(&steps).map_err(err)?;
        Ok(PatternTomlPayload { steps, accepted })
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
            timestamp_ns: e.timestamp_ns,
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

    // --- pin_map_from_hex ---

    #[test]
    fn pin_map_from_hex_minimal_seven_bytes() {
        // v=1 out=0:8 in=8:15 pull=down flags=0x03 — exactly 7 bytes
        let map = pin_map_from_hex("010008080f0203").unwrap();
        assert_eq!(map.out_count, 8);
        assert_eq!(map.in_count, 15);
        assert_eq!(map.pull, PullMode::Down);
    }

    #[test]
    fn pin_map_from_hex_round_trip() {
        let hex = "010008080f02030000000000000000000000000000000000";
        let map = pin_map_from_hex(hex).unwrap();
        assert_eq!(map.version, 1);
        assert_eq!(map.out_base, 0);
        assert_eq!(map.out_count, 8);
        assert_eq!(map.in_base, 8);
        assert_eq!(map.in_count, 15);
        assert_eq!(map.pull, PullMode::Down);
        assert_eq!(map.flags, 0x03);
    }

    #[test]
    fn pin_map_from_hex_rejects_short_input() {
        assert!(pin_map_from_hex("0100").unwrap_err().contains("too short"));
    }

    #[test]
    fn pin_map_from_hex_rejects_bad_pull() {
        let hex = "010008080f07030000000000000000000000000000000000";
        assert!(pin_map_from_hex(hex).unwrap_err().contains("pull"));
    }

    #[test]
    fn pin_map_from_hex_rejects_non_hex() {
        let hex = "zz0008080f02030000000000000000000000000000000000";
        assert!(pin_map_from_hex(hex).unwrap_err().contains("byte 0"));
    }

    // --- reconcile_rows ---

    fn ev(raw_count: u32, raw_phase: u8) -> TimestampEvent {
        TimestampEvent {
            inputs: 0x100,
            raw_count,
            raw_phase,
            sync_active: true,
            timestamp_ns: reconcile::as_is_ns(raw_count, raw_phase),
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
