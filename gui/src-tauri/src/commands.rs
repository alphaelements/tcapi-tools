//! Tauri command surface (`docs/gui-feature-spec.md` §9): thin typed
//! wrappers over `pochi-sdk` calls against the shared connection.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use pochi_sdk::reconcile::{self, SourceEvent};
use pochi_sdk::{
    config, Capabilities, Connection, DeviceInfo, EdgeMode, Feature, IoState, PatternMode,
    PatternStatus, PatternStep, PinMap, SafetyConfig, SafetyState, TimestampResult, VersionInfo,
    TS_GET_MAX,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::events::{self, LogPayload};
use crate::state::{with_state, AppInner, SharedState};

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
        inner.release_connection();
        let mut conn = Connection::open(&port).map_err(err)?;
        conn.set_traffic_hook(Some(events::traffic_hook(app.clone())));
        let info = conn.info().map_err(err)?;
        let watchdog_capable = conn.caps().map_err(err)?.has(Feature::Wdog);
        attach(
            inner,
            conn,
            info.clone(),
            watchdog_capable,
            heartbeat_starter(app),
        )?;
        Ok(info)
    })
    .await
}

/// Make `conn` the active connection. The watchdog outlives a host session:
/// one enabled before this connection (a reloaded webview, another tool)
/// trips the device unless this session keeps it fed, so a watchdog-capable
/// device gets its heartbeat aligned right away. When that fails the
/// connection is dropped again (closing changes no output) and the error
/// is returned.
fn attach<S>(
    inner: &mut AppInner,
    conn: Connection,
    info: DeviceInfo,
    watchdog_capable: bool,
    start: S,
) -> Result<(), String>
where
    S: FnOnce(&mut Connection, u32) -> Result<Arc<AtomicBool>, String>,
{
    inner.connection = Some(conn);
    inner.device_info = Some(info);
    if watchdog_capable {
        if let Err(e) = sync_heartbeat(inner, start) {
            inner.release_connection();
            return Err(e);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| {
        // Dropping the connection closes the port; stop the forwarder and
        // the heartbeat too. Closing sends nothing and changes no output.
        inner.release_connection();
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

/// Start or stop forwarding push events to the webview. The SDK owns the
/// device `subscribe` state: it follows the forwarder's receiver.
#[tauri::command]
pub async fn subscribe(
    app: AppHandle,
    state: State<'_, SharedState>,
    enable: bool,
) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        if !enable {
            inner.stop_events();
            return Ok(());
        }
        if inner.event_stop.is_some() {
            return Ok(());
        }
        let rx = inner.conn()?.subscribe_events().map_err(err)?;
        inner.event_stop = Some(events::spawn_forwarder(app, rx));
        Ok(())
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

/// Evaluate a `map.toml` (schema v2, `docs/config-files.md`) into a
/// [`PinMap`] without touching the device; the frontend reviews it and
/// applies it via `map_set`. Errors read `<path>:<line>: <message>`.
fn load_map_file(path: &str) -> Result<PinMap, String> {
    config::load_map(Path::new(path)).map_err(err)
}

#[tauri::command]
pub async fn map_load_toml(path: String) -> Result<PinMap, String> {
    tauri::async_runtime::spawn_blocking(move || load_map_file(&path))
        .await
        .map_err(|e| format!("blocking task failed: {e}"))?
}

// --- pattern ---

/// Parse a `pattern.toml` into steps with holds already in pattern ticks.
fn load_pattern_file(path: &str) -> Result<Vec<PatternStep>, String> {
    config::load_pattern(Path::new(path)).map_err(err)
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
        let steps = load_pattern_file(&path)?;
        let accepted = inner.conn()?.pattern_load(&steps).map_err(err)?;
        Ok(PatternTomlPayload { steps, accepted })
    })
    .await
}

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
        inner.stop_heartbeat();
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
        inner.stop_heartbeat();
        let conn = inner
            .connection
            .take()
            .ok_or_else(|| "no device connected".to_string())?;
        inner.device_info = None;
        conn.bootsel_reset().map_err(err)
    })
    .await
}

// --- safety ---

/// Starts the heartbeat for a watchdog timeout the device has and returns
/// the stop flag of the thread that owns it. The seam between the safety
/// logic and the Tauri app handle (tests pass a recording starter).
fn heartbeat_starter(
    app: AppHandle,
) -> impl FnOnce(&mut Connection, u32) -> Result<Arc<AtomicBool>, String> {
    move |conn, wdog_ms| {
        let heartbeat = conn.start_heartbeat(wdog_ms).map_err(err)?;
        Ok(events::spawn_heartbeat_monitor(app, heartbeat))
    }
}

/// Restart the watchdog heartbeat for a watchdog timeout the device now
/// has: any running heartbeat is stopped first, and none is started for `0`
/// (disabled). The heartbeat only ever pings; ending it changes no output.
fn restart_heartbeat<S>(inner: &mut AppInner, wdog_ms: u32, start: S) -> Result<(), String>
where
    S: FnOnce(&mut Connection, u32) -> Result<Arc<AtomicBool>, String>,
{
    inner.stop_heartbeat();
    if wdog_ms == 0 {
        return Ok(());
    }
    let stop = start(inner.conn()?, wdog_ms)?;
    inner.heartbeat_stop = Some(stop);
    Ok(())
}

/// Read the device's real watchdog timeout (`safety`) and align the
/// heartbeat with it. Used where the device state is not known from a
/// command's success: on connect and after a failed `apply_safety`.
fn sync_heartbeat<S>(inner: &mut AppInner, start: S) -> Result<(), String>
where
    S: FnOnce(&mut Connection, u32) -> Result<Arc<AtomicBool>, String>,
{
    let state = inner.conn()?.safety().map_err(err)?;
    restart_heartbeat(inner, state.wdog_ms, start)
}

/// `wdog <ms>` and the heartbeat that goes with it. A watchdog the host
/// cannot feed would trip the device, so when the heartbeat fails to start
/// the watchdog is disabled again and the failure (and a failed disable) is
/// reported.
fn set_watchdog<S>(inner: &mut AppInner, ms: u32, start: S) -> Result<(), String>
where
    S: FnOnce(&mut Connection, u32) -> Result<Arc<AtomicBool>, String>,
{
    inner.conn()?.wdog(ms).map_err(err)?;
    let Err(started) = restart_heartbeat(inner, ms, start) else {
        return Ok(());
    };
    match inner.conn()?.wdog(0) {
        Ok(()) => Err(started),
        Err(revert) => Err(format!(
            "{started}; the watchdog could not be disabled again: {revert}"
        )),
    }
}

/// `wdog <ms>` — enable (`100..=10000`) or disable (`0`) the watchdog. An
/// enabled watchdog starts the heartbeat that keeps it fed while this
/// connection lives; disabling stops it.
#[tauri::command]
pub async fn wdog(app: AppHandle, state: State<'_, SharedState>, ms: u32) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        set_watchdog(inner, ms, heartbeat_starter(app))
    })
    .await
}

/// `safety` — the safety state; the source of truth for `pochi://failsafe`.
#[tauri::command]
pub async fn get_safety(state: State<'_, SharedState>) -> Result<SafetyState, String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.safety().map_err(err)).await
}

/// `failsafe clear` — release the failsafe latch; outputs stay as they are.
#[tauri::command]
pub async fn failsafe_clear(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.failsafe_clear().map_err(err)).await
}

/// `outputs reset` — every output to its `def` (the safe state); stops a
/// running pattern.
#[tauri::command]
pub async fn outputs_reset(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.outputs_reset().map_err(err)).await
}

/// `excl set <mask>...` — replace all exclusive groups atomically.
#[tauri::command]
pub async fn excl_set(state: State<'_, SharedState>, masks: Vec<u32>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        inner.conn()?.excl_set(&masks).map_err(err)
    })
    .await
}

/// `excl clear` — remove all exclusive groups.
#[tauri::command]
pub async fn excl_clear(state: State<'_, SharedState>) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.excl_clear().map_err(err)).await
}

/// `excl get` — the masks of the exclusive groups in the order they were set.
#[tauri::command]
pub async fn excl_get(state: State<'_, SharedState>) -> Result<Vec<u32>, String> {
    let shared = state.inner().clone();
    with_state(shared, |inner| inner.conn()?.excl_get().map_err(err)).await
}

/// `usbsafe on|off` — failsafe when the USB link is lost.
#[tauri::command]
pub async fn usbsafe(state: State<'_, SharedState>, on: bool) -> Result<(), String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| inner.conn()?.usbsafe(on).map_err(err)).await
}

/// Evaluate a `safety.toml` (schema v2, `docs/config-files.md` section 7)
/// into a [`SafetyConfig`] without touching the device; the frontend reviews
/// it and applies it via `apply_safety`. Errors read `<path>:<line>: <message>`.
fn load_safety_file(path: &str) -> Result<SafetyConfig, String> {
    config::load_safety(Path::new(path)).map_err(err)
}

#[tauri::command]
pub async fn safety_load_toml(path: String) -> Result<SafetyConfig, String> {
    tauri::async_runtime::spawn_blocking(move || load_safety_file(&path))
        .await
        .map_err(|e| format!("blocking task failed: {e}"))?
}

/// `apply_safety` plus the heartbeat that follows the watchdog the device
/// ends up with: after a failure part of the commands may be in effect, so
/// the real `safety` state decides.
fn apply_and_follow<S>(
    inner: &mut AppInner,
    config: &SafetyConfig,
    start: S,
) -> Result<SafetyState, String>
where
    S: FnOnce(&mut Connection, u32) -> Result<Arc<AtomicBool>, String>,
{
    match inner.conn()?.apply_safety(config) {
        Ok(applied) => {
            restart_heartbeat(inner, applied.wdog_ms, start)?;
            Ok(applied)
        }
        Err(e) => {
            let message = err(e);
            match sync_heartbeat(inner, start) {
                Ok(()) => Err(message),
                Err(sync) => Err(format!("{message}; heartbeat not aligned: {sync}")),
            }
        }
    }
}

/// Make the device equal to `config` and verify it (`apply_safety`), then
/// keep the heartbeat in step with its watchdog.
#[tauri::command]
pub async fn apply_safety(
    app: AppHandle,
    state: State<'_, SharedState>,
    config: SafetyConfig,
) -> Result<SafetyState, String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        apply_and_follow(inner, &config, heartbeat_starter(app))
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

fn as_is_rows(result: &TimestampResult, ts_res_ns: u32) -> Vec<TsRow> {
    result
        .events
        .iter()
        .map(|e| TsRow {
            inputs: e.inputs,
            raw_count: e.raw_count,
            raw_phase: e.raw_phase,
            sync_active: e.sync_active,
            timestamp_ns: e.ns(ts_res_ns),
            reconciled: false,
        })
        .collect()
}

/// Collect up to `max_events` events through `fetch` (one `ts get` per
/// call). The protocol caps a single response at [`TS_GET_MAX`] events, so a
/// larger request is split; a short answer means the device ring is empty.
/// The overflow flag of any call is kept.
fn drain_ts<F>(max_events: u16, mut fetch: F) -> Result<TimestampResult, String>
where
    F: FnMut(u16) -> Result<TimestampResult, String>,
{
    if max_events == 0 {
        return Err("max_events must be at least 1".to_string());
    }
    let mut events = Vec::new();
    let mut overflow = false;
    let mut remaining = max_events;
    while remaining > 0 {
        let chunk = remaining.min(TS_GET_MAX);
        let batch = fetch(chunk)?;
        overflow |= batch.overflow;
        let got = batch.events.len();
        events.extend(batch.events);
        if got < usize::from(chunk) {
            break;
        }
        remaining -= chunk;
    }
    Ok(TimestampResult {
        events,
        reconciled: false,
        overflow,
    })
}

/// `ts get` for up to `max_events` events, drained across protocol-sized
/// calls, plus the device's `ts_res_ns`.
fn capture_ts(conn: &mut Connection, max_events: u16) -> Result<(TimestampResult, u32), String> {
    let ts_res_ns = conn.caps().map_err(err)?.ts_res_ns;
    let result = drain_ts(max_events, |n| conn.ts_get(n).map_err(err))?;
    Ok((result, ts_res_ns))
}

#[tauri::command]
pub async fn ts_get(
    state: State<'_, SharedState>,
    max_events: u16,
) -> Result<TsResultPayload, String> {
    let shared = state.inner().clone();
    with_state(shared, move |inner| {
        let (result, ts_res_ns) = capture_ts(inner.conn()?, max_events)?;
        Ok(TsResultPayload {
            events: as_is_rows(&result, ts_res_ns),
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
        let (result, ts_res_ns) = capture_ts(inner.conn()?, max_events)?;
        Ok(reconcile_rows(&result, ts_res_ns))
    })
    .await
}

/// Apply host-side straddle reconciliation to a raw capture, preserving
/// the device's event order.
fn reconcile_rows(result: &TimestampResult, ts_res_ns: u32) -> TsResultPayload {
    let mut rows = as_is_rows(result, ts_res_ns);

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

    let groups = reconcile::group_events(&source_events, ts_res_ns);
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
    with_state(shared, move |inner| {
        let lines = inner.conn()?.raw(&text).map_err(err)?;
        Ok(lines.join("\n"))
    })
    .await
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

    /// Capabilities.ts_res_ns of the v2 firmware.
    const TS_RES_NS: u32 = 40;

    // --- TOML loading through the SDK config parsers ---

    fn fixture(name: &str) -> String {
        format!("{}/../../docs/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    #[test]
    fn load_map_file_evaluates_the_sdk_schema() {
        let map = load_map_file(&fixture("map-mixed-io.toml")).unwrap();
        assert_eq!(map.direction, 0x0000_0003);
        assert_eq!(map.pull_up, 0x0400_0004);
        assert_eq!(map.edge, 0x0c7f_fff4);
        assert_eq!(map.flags, 0);
    }

    #[test]
    fn load_map_file_reports_file_and_line_of_a_syntax_error() {
        let path = fixture("map-toml-syntax.toml");
        let e = load_map_file(&path).unwrap_err();
        // The fixture's syntax error is on line 6 (`# expected_line: 6`).
        assert!(e.contains(&format!("{path}:6: toml syntax")), "{e}");
    }

    #[test]
    fn load_map_file_rejects_a_missing_file() {
        let e = load_map_file(&fixture("does-not-exist.toml")).unwrap_err();
        assert!(!e.is_empty());
    }

    #[test]
    fn load_pattern_file_converts_holds_to_ticks() {
        let steps = load_pattern_file(&fixture("pattern-basic.toml")).unwrap();
        assert_eq!(
            steps,
            vec![
                PatternStep {
                    out_bits: 0x5,
                    hold_ticks: 5
                },
                PatternStep {
                    out_bits: 0x0,
                    hold_ticks: 10
                },
                PatternStep {
                    out_bits: 0x0400_0000,
                    hold_ticks: 1
                },
            ]
        );
    }

    #[test]
    fn load_pattern_file_rejects_a_v1_style_file_naming_the_version() {
        let e = load_pattern_file(&fixture("map-invalid-version.toml")).unwrap_err();
        assert!(e.contains("version"), "{e}");
    }

    // --- safety.toml loading ---

    #[test]
    fn load_safety_file_evaluates_the_sdk_schema() {
        let config = load_safety_file(&fixture("safety-full.toml")).unwrap();
        assert_eq!(
            config,
            SafetyConfig {
                watchdog_ms: 800,
                usbsafe: true,
                groups: vec![0x0c, 0x18],
            }
        );
    }

    #[test]
    fn load_safety_file_reports_file_and_line_of_a_syntax_error() {
        let path = fixture("safety-toml-syntax.toml");
        let e = load_safety_file(&path).unwrap_err();
        assert!(e.contains(&format!("{path}:")), "{e}");
        assert!(e.contains("toml syntax"), "{e}");
    }

    #[test]
    fn load_safety_file_rejects_an_out_of_range_watchdog() {
        let e = load_safety_file(&fixture("safety-watchdog-too-large.toml")).unwrap_err();
        assert!(e.contains("timeout_ms"), "{e}");
    }

    #[test]
    fn load_safety_file_rejects_a_missing_file() {
        let e = load_safety_file(&fixture("does-not-exist.toml")).unwrap_err();
        assert!(!e.is_empty());
    }

    // --- drain_ts ---

    fn batch(count: usize, overflow: bool) -> TimestampResult {
        TimestampResult {
            events: (0..count).map(|i| ev(i as u32, 0)).collect(),
            reconciled: false,
            overflow,
        }
    }

    #[test]
    fn drain_ts_splits_a_large_request_into_protocol_sized_calls() {
        let mut asked = Vec::new();
        let mut pending = 200usize;
        let result = drain_ts(512, |n| {
            asked.push(n);
            let take = pending.min(usize::from(n));
            pending -= take;
            Ok(batch(take, false))
        })
        .unwrap();
        assert_eq!(result.events.len(), 200);
        // 85 + 85 + 30: the last call comes back short, which ends the drain.
        assert_eq!(asked, vec![85, 85, 85]);
    }

    #[test]
    fn drain_ts_stops_at_the_requested_maximum() {
        let mut asked = Vec::new();
        let result = drain_ts(100, |n| {
            asked.push(n);
            Ok(batch(usize::from(n), false))
        })
        .unwrap();
        assert_eq!(result.events.len(), 100);
        assert_eq!(asked, vec![85, 15]);
    }

    #[test]
    fn drain_ts_keeps_the_overflow_flag_of_any_call() {
        let mut call = 0;
        let result = drain_ts(170, |n| {
            call += 1;
            Ok(batch(usize::from(n), call == 1))
        })
        .unwrap();
        assert!(result.overflow);
    }

    #[test]
    fn drain_ts_with_nothing_pending_is_empty() {
        let result = drain_ts(10, |_| Ok(batch(0, false))).unwrap();
        assert!(result.events.is_empty());
        assert!(!result.overflow);
    }

    #[test]
    fn drain_ts_propagates_a_device_error() {
        let e = drain_ts(10, |_| Err("ts get: device error: NOT_ARMED".to_string())).unwrap_err();
        assert!(e.contains("NOT_ARMED"));
    }

    #[test]
    fn drain_ts_rejects_zero() {
        assert!(drain_ts(0, |_| Ok(batch(0, false))).is_err());
    }

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
        let payload = reconcile_rows(&result, TS_RES_NS);
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
        let payload = reconcile_rows(&result, TS_RES_NS);
        assert!(payload.events.iter().all(|r| !r.reconciled));
        assert_eq!(
            payload.events[0].timestamp_ns,
            reconcile::as_is_ns(1000, 5, TS_RES_NS)
        );
    }

    #[test]
    fn reconcile_rows_preserves_device_order() {
        // Events arrive out of count order; rows must stay in arrival order.
        let result = TimestampResult {
            events: vec![ev(5000, 9), ev(1000, 5)],
            reconciled: false,
            overflow: false,
        };
        let payload = reconcile_rows(&result, TS_RES_NS);
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
        let payload = reconcile_rows(&result, TS_RES_NS);
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
        let payload = reconcile_rows(&result, TS_RES_NS);
        assert!(payload.overflow);
    }
}

/// The safety command bodies against a fake device on a PTY: what the
/// device is sent and how the heartbeat follows the watchdog it ends up
/// with. The heartbeat itself is replaced by a recording starter (its
/// behaviour is covered by the SDK); what is tested is when it is started,
/// restarted and stopped.
#[cfg(all(test, unix))]
mod safety_flow_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use serialport::{SerialPort, TTYPort};

    /// What the fake firmware keeps: the safety settings, every command it
    /// was sent (handshake and pings excluded) and the commands it refuses.
    #[derive(Default)]
    struct DeviceModel {
        wdog_ms: u32,
        usbsafe: bool,
        excl: Vec<u32>,
        log: Vec<String>,
        refuse: Vec<&'static str>,
        /// Answered `ping`s: what the real heartbeat sends, kept out of
        /// `log` so command assertions stay about commands.
        pings: u32,
    }

    fn hex_masks<'a>(words: impl Iterator<Item = &'a str>) -> Vec<u32> {
        words
            .map(|w| u32::from_str_radix(w.trim_start_matches("0x"), 16).expect("hex mask"))
            .collect()
    }

    fn answer(model: &mut DeviceModel, cmd: &str) -> Vec<String> {
        if cmd == "version" {
            return vec!["OK fw=0.1.3 proto=2".to_string()];
        }
        if let Some(n) = cmd.strip_prefix("ping ") {
            model.pings += 1;
            return vec![format!("OK pong={n}")];
        }
        model.log.push(cmd.to_string());
        if model.refuse.iter().any(|p| cmd.starts_with(p)) {
            return vec!["ERR BAD_PARAM".to_string()];
        }
        let mut words = cmd.split_whitespace();
        match (words.next(), words.next()) {
            (Some("wdog"), Some(ms)) => {
                model.wdog_ms = ms.parse().expect("wdog ms");
                vec!["OK".to_string()]
            }
            (Some("usbsafe"), Some(on)) => {
                model.usbsafe = on == "on";
                vec!["OK".to_string()]
            }
            (Some("excl"), Some("clear")) => {
                model.excl.clear();
                vec!["OK".to_string()]
            }
            (Some("excl"), Some("set")) => {
                model.excl = hex_masks(words);
                vec!["OK".to_string()]
            }
            (Some("excl"), Some("get")) => {
                let mut lines = vec![format!("OK count={}", model.excl.len())];
                lines.extend(model.excl.iter().map(|m| format!("  mask={m:#010x}")));
                lines
            }
            (Some("safety"), None) => vec![format!(
                "OK wdog_ms={} remaining_ms={} failsafe=0 cause=none usbsafe={} excl={}",
                model.wdog_ms,
                model.wdog_ms,
                u8::from(model.usbsafe),
                model.excl.len()
            )],
            _ => vec!["ERR UNKNOWN_CMD".to_string()],
        }
    }

    struct FakeFirmware {
        model: Arc<Mutex<DeviceModel>>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl FakeFirmware {
        fn commands(&self) -> Vec<String> {
            self.model.lock().unwrap().log.clone()
        }

        fn pings(&self) -> u32 {
            self.model.lock().unwrap().pings
        }
    }

    impl Drop for FakeFirmware {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(t) = self.thread.take() {
                drop(t.join());
            }
        }
    }

    /// A connection to a fake device holding `model`.
    fn open(model: DeviceModel) -> (Connection, FakeFirmware) {
        // `TTYPort::pair` goes through the thread-unsafe `ptsname`.
        static PAIR_LOCK: Mutex<()> = Mutex::new(());
        let (mut master, slave) = {
            let _guard = PAIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            TTYPort::pair().expect("PTY pair")
        };
        let model = Arc::new(Mutex::new(model));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::spawn({
            let model = Arc::clone(&model);
            let stop = Arc::clone(&stop);
            move || {
                master
                    .set_timeout(Duration::from_millis(20))
                    .expect("set_timeout");
                let mut acc: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 256];
                while !stop.load(Ordering::Relaxed) {
                    match master.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            acc.extend_from_slice(&chunk[..n]);
                            while let Some(pos) = acc.iter().position(|&b| b == b'\n') {
                                let line: Vec<u8> = acc.drain(..=pos).collect();
                                let cmd = String::from_utf8_lossy(&line)
                                    .trim_end_matches(['\r', '\n'])
                                    .to_string();
                                if cmd.is_empty() {
                                    continue;
                                }
                                let lines = answer(&mut model.lock().unwrap(), &cmd);
                                let wire: String =
                                    lines.iter().map(|l| format!("{l}\r\n")).collect();
                                master.write_all(wire.as_bytes()).expect("mock write");
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(_) => break,
                    }
                }
            }
        });
        let mut conn = Connection::from_port(Box::new(slave)).expect("connect");
        conn.set_timeout(Duration::from_millis(500));
        (
            conn,
            FakeFirmware {
                model,
                stop,
                thread: Some(thread),
            },
        )
    }

    fn inner_with(conn: Connection) -> AppInner {
        AppInner {
            connection: Some(conn),
            ..AppInner::default()
        }
    }

    /// Heartbeat starter that records the timeouts it was asked for.
    #[derive(Default, Clone)]
    struct Starts(Arc<Mutex<Vec<u32>>>);

    impl Starts {
        fn starter(&self) -> impl FnOnce(&mut Connection, u32) -> Result<Arc<AtomicBool>, String> {
            let log = Arc::clone(&self.0);
            move |_, ms| {
                log.lock().unwrap().push(ms);
                Ok(Arc::new(AtomicBool::new(false)))
            }
        }

        fn timeouts(&self) -> Vec<u32> {
            self.0.lock().unwrap().clone()
        }
    }

    fn running_heartbeat(inner: &mut AppInner) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        inner.heartbeat_stop = Some(Arc::clone(&flag));
        flag
    }

    /// Handle on the monitor thread of a real heartbeat.
    type Monitor = Arc<Mutex<Option<JoinHandle<()>>>>;

    /// Heartbeat starter that runs the SDK's real heartbeat (pinging the fake
    /// firmware) under the same `watch_heartbeat` loop the app uses, only
    /// without a Tauri `AppHandle` to emit failures to. The monitor thread is
    /// kept in `monitor` so a test can wait for it to finish.
    fn real_starter(
        monitor: &Monitor,
    ) -> impl FnOnce(&mut Connection, u32) -> Result<Arc<AtomicBool>, String> {
        let monitor = Arc::clone(monitor);
        move |conn, ms| {
            let heartbeat = conn.start_heartbeat(ms).map_err(err)?;
            let stop = Arc::new(AtomicBool::new(false));
            let thread = std::thread::spawn({
                let stop = Arc::clone(&stop);
                move || {
                    events::watch_heartbeat(
                        &stop,
                        || match heartbeat.wait_failure(Duration::from_millis(20)) {
                            Some(e) => events::HeartbeatPoll::Failed(e.to_string()),
                            None if heartbeat.is_running() => events::HeartbeatPoll::Running,
                            None => events::HeartbeatPoll::Ended,
                        },
                        drop,
                    );
                    heartbeat.stop();
                }
            });
            *monitor.lock().unwrap() = Some(thread);
            Ok(stop)
        }
    }

    /// Block until `cond` holds (up to 5 s).
    fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(std::time::Instant::now() < deadline, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn failing_starter(_: &mut Connection, _: u32) -> Result<Arc<AtomicBool>, String> {
        Err("heartbeat thread failed".to_string())
    }

    // --- wdog ---

    #[test]
    fn wdog_enable_sends_the_command_and_starts_the_heartbeat() {
        let (conn, fw) = open(DeviceModel::default());
        let mut inner = inner_with(conn);
        let starts = Starts::default();
        set_watchdog(&mut inner, 500, starts.starter()).unwrap();
        assert_eq!(fw.commands(), ["wdog 500"]);
        assert_eq!(starts.timeouts(), [500]);
        assert!(inner.heartbeat_stop.is_some());
    }

    #[test]
    fn wdog_enable_replaces_a_running_heartbeat() {
        let (conn, _fw) = open(DeviceModel::default());
        let mut inner = inner_with(conn);
        let old = running_heartbeat(&mut inner);
        let starts = Starts::default();
        set_watchdog(&mut inner, 200, starts.starter()).unwrap();
        assert!(old.load(Ordering::Relaxed), "the old heartbeat is stopped");
        assert_eq!(starts.timeouts(), [200]);
    }

    #[test]
    fn wdog_disable_stops_the_heartbeat_and_starts_none() {
        let (conn, fw) = open(DeviceModel {
            wdog_ms: 500,
            ..DeviceModel::default()
        });
        let mut inner = inner_with(conn);
        let old = running_heartbeat(&mut inner);
        let starts = Starts::default();
        set_watchdog(&mut inner, 0, starts.starter()).unwrap();
        assert_eq!(fw.commands(), ["wdog 0"]);
        assert!(old.load(Ordering::Relaxed));
        assert!(starts.timeouts().is_empty());
        assert!(inner.heartbeat_stop.is_none());
    }

    #[test]
    fn wdog_refused_by_the_device_leaves_the_heartbeat_alone() {
        let (conn, _fw) = open(DeviceModel {
            refuse: vec!["wdog"],
            ..DeviceModel::default()
        });
        let mut inner = inner_with(conn);
        let old = running_heartbeat(&mut inner);
        let starts = Starts::default();
        let error = set_watchdog(&mut inner, 500, starts.starter()).unwrap_err();
        assert!(error.contains("BAD_PARAM"), "{error}");
        assert!(!old.load(Ordering::Relaxed), "the old watchdog still runs");
        assert!(starts.timeouts().is_empty());
    }

    #[test]
    fn wdog_whose_heartbeat_cannot_start_is_switched_off_again() {
        let (conn, fw) = open(DeviceModel::default());
        let mut inner = inner_with(conn);
        let error = set_watchdog(&mut inner, 500, failing_starter).unwrap_err();
        assert!(error.contains("heartbeat thread failed"), "{error}");
        // A watchdog nobody feeds would trip the device; it is disabled.
        assert_eq!(fw.commands(), ["wdog 500", "wdog 0"]);
        assert!(inner.heartbeat_stop.is_none());
    }

    #[test]
    fn wdog_whose_heartbeat_cannot_start_reports_a_failed_revert_too() {
        let (conn, fw) = open(DeviceModel::default());
        let mut inner = inner_with(conn);
        // The revert is the second `wdog`; make the device refuse it by
        // refusing "wdog 0" only.
        fw.model.lock().unwrap().refuse = vec!["wdog 0"];
        let error = set_watchdog(&mut inner, 500, failing_starter).unwrap_err();
        assert!(error.contains("heartbeat thread failed"), "{error}");
        assert!(error.contains("could not be disabled"), "{error}");
    }

    // --- apply_safety ---

    fn config(watchdog_ms: u32) -> SafetyConfig {
        SafetyConfig {
            watchdog_ms,
            usbsafe: true,
            groups: vec![0x3, 0xc],
        }
    }

    #[test]
    fn apply_safety_starts_the_heartbeat_for_the_applied_watchdog() {
        let (conn, fw) = open(DeviceModel::default());
        let mut inner = inner_with(conn);
        let starts = Starts::default();
        let applied = apply_and_follow(&mut inner, &config(300), starts.starter()).unwrap();
        assert_eq!(applied.wdog_ms, 300);
        assert_eq!(starts.timeouts(), [300]);
        assert_eq!(
            fw.commands()[..3],
            ["excl set 0x3 0xc", "usbsafe on", "wdog 300"]
        );
    }

    #[test]
    fn apply_safety_without_a_watchdog_stops_the_running_heartbeat() {
        let (conn, _fw) = open(DeviceModel {
            wdog_ms: 500,
            ..DeviceModel::default()
        });
        let mut inner = inner_with(conn);
        let old = running_heartbeat(&mut inner);
        let starts = Starts::default();
        apply_and_follow(&mut inner, &config(0), starts.starter()).unwrap();
        assert!(old.load(Ordering::Relaxed));
        assert!(starts.timeouts().is_empty());
        assert!(inner.heartbeat_stop.is_none());
    }

    #[test]
    fn failed_apply_aligns_the_heartbeat_with_the_real_watchdog() {
        // `usbsafe` is refused after `excl set` went through; the device
        // still has the watchdog it had before (250 ms).
        let (conn, fw) = open(DeviceModel {
            wdog_ms: 250,
            refuse: vec!["usbsafe"],
            ..DeviceModel::default()
        });
        let mut inner = inner_with(conn);
        let old = running_heartbeat(&mut inner);
        let starts = Starts::default();
        let error = apply_and_follow(&mut inner, &config(300), starts.starter()).unwrap_err();
        assert!(error.contains("BAD_PARAM"), "{error}");
        assert!(!error.contains("heartbeat not aligned"), "{error}");
        assert!(old.load(Ordering::Relaxed), "the old heartbeat is replaced");
        assert_eq!(starts.timeouts(), [250]);
        assert_eq!(fw.commands().last().map(String::as_str), Some("safety"));
    }

    #[test]
    fn failed_apply_that_cannot_read_safety_reports_both() {
        let (conn, _fw) = open(DeviceModel {
            refuse: vec!["usbsafe", "safety"],
            ..DeviceModel::default()
        });
        let mut inner = inner_with(conn);
        let starts = Starts::default();
        let error = apply_and_follow(&mut inner, &config(300), starts.starter()).unwrap_err();
        assert!(error.contains("BAD_PARAM"), "{error}");
        assert!(error.contains("heartbeat not aligned"), "{error}");
        assert!(starts.timeouts().is_empty());
    }

    // --- heartbeat end ---

    /// Run a real 100 ms watchdog heartbeat (a ping every 25 ms) against the
    /// fake firmware and wait until it has been fed.
    fn running_real_heartbeat(
        fw: &FakeFirmware,
        inner: &mut AppInner,
        monitor: &Monitor,
    ) -> Arc<AtomicBool> {
        set_watchdog(inner, 100, real_starter(monitor)).unwrap();
        wait_until("the heartbeat feeds the device", || fw.pings() >= 3);
        Arc::clone(inner.heartbeat_stop.as_ref().expect("heartbeat running"))
    }

    /// Nothing but the `wdog` command was ever sent: no `outputs reset`, no
    /// `write`, nothing that changes an output.
    fn assert_no_output_change(fw: &FakeFirmware) {
        assert_eq!(fw.commands(), ["wdog 100"]);
    }

    /// After `stopped`, the heartbeat must stay silent for several periods.
    fn assert_silent(fw: &FakeFirmware) {
        let settled = fw.pings();
        std::thread::sleep(Duration::from_millis(200)); // 8 periods
        assert_eq!(fw.pings(), settled, "no ping after the heartbeat ended");
    }

    #[test]
    fn heartbeat_stops_without_output_change() {
        let (conn, fw) = open(DeviceModel::default());
        let mut inner = inner_with(conn);
        let monitor = Monitor::default();
        let flag = running_real_heartbeat(&fw, &mut inner, &monitor);

        // Disconnect: the heartbeat ends and the device is told nothing.
        inner.release_connection();
        assert!(
            flag.load(Ordering::Relaxed),
            "the heartbeat is told to stop"
        );
        assert!(inner.heartbeat_stop.is_none() && inner.connection.is_none());
        monitor.lock().unwrap().take().unwrap().join().unwrap();

        assert_silent(&fw);
        assert_no_output_change(&fw);
    }

    #[test]
    fn heartbeat_ends_when_the_connection_is_dropped_without_output_change() {
        let (conn, fw) = open(DeviceModel::default());
        let mut inner = inner_with(conn);
        let monitor = Monitor::default();
        let flag = running_real_heartbeat(&fw, &mut inner, &monitor);

        // The connection goes away (a reset or an unplug) without anyone
        // stopping the heartbeat: it notices by itself and ends.
        inner.connection = None;
        wait_until("the monitor sees the heartbeat end", || {
            flag.load(Ordering::Relaxed)
        });
        monitor.lock().unwrap().take().unwrap().join().unwrap();

        assert_silent(&fw);
        assert_no_output_change(&fw);
    }

    // --- connect ---

    #[test]
    fn attach_keeps_an_already_enabled_watchdog_fed() {
        let (conn, _fw) = open(DeviceModel {
            wdog_ms: 250,
            ..DeviceModel::default()
        });
        let mut inner = AppInner::default();
        let starts = Starts::default();
        attach(&mut inner, conn, device_info(), true, starts.starter()).unwrap();
        assert_eq!(starts.timeouts(), [250]);
        assert!(inner.connection.is_some() && inner.device_info.is_some());
        assert!(inner.heartbeat_stop.is_some());
    }

    #[test]
    fn attach_to_a_device_without_watchdog_sends_nothing() {
        let (conn, fw) = open(DeviceModel::default());
        let mut inner = AppInner::default();
        let starts = Starts::default();
        attach(&mut inner, conn, device_info(), false, starts.starter()).unwrap();
        assert!(fw.commands().is_empty());
        assert!(starts.timeouts().is_empty());
        assert!(inner.connection.is_some());
    }

    #[test]
    fn attach_with_a_disabled_watchdog_starts_no_heartbeat() {
        let (conn, fw) = open(DeviceModel::default());
        let mut inner = AppInner::default();
        let starts = Starts::default();
        attach(&mut inner, conn, device_info(), true, starts.starter()).unwrap();
        assert_eq!(fw.commands(), ["safety"]);
        assert!(starts.timeouts().is_empty());
        assert!(inner.heartbeat_stop.is_none());
    }

    #[test]
    fn attach_that_cannot_align_the_heartbeat_drops_the_connection() {
        let (conn, _fw) = open(DeviceModel {
            wdog_ms: 250,
            ..DeviceModel::default()
        });
        let mut inner = AppInner::default();
        let error = attach(&mut inner, conn, device_info(), true, failing_starter).unwrap_err();
        assert!(error.contains("heartbeat thread failed"), "{error}");
        assert!(inner.connection.is_none() && inner.device_info.is_none());
        assert!(inner.heartbeat_stop.is_none());
    }

    fn device_info() -> DeviceInfo {
        DeviceInfo {
            uid: "0123456789ABCDEF".to_string(),
            device_number: None,
            port: "fake".to_string(),
            version: Some("0.1.3".to_string()),
        }
    }
}
