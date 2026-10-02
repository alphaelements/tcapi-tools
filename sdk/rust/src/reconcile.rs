//! Host-side timestamp reconciliation (FW Phase 9.6).
//!
//! The device sends raw `(count, phase)` pairs. Because the three DMA
//! channels (snapshot / count / phase) latch tens of ns apart, count and
//! phase can straddle a µs boundary within one event (~8%). Reconciliation
//! picks, for K events assumed to share one physical instant, the
//! combination of candidate ns values that minimizes total pairwise |diff|.

use serde::{Deserialize, Serialize};

/// Exhaustive search limit: 3^8 = 6561 combinations. Larger groups fall
/// back to as-is values (pruning search is deferred until needed).
pub const MAX_EXHAUSTIVE_K: usize = 8;

/// The three physically possible ns values for one `(count, phase)` event:
/// `[as-is, count-1, count+1]`. Always all three — boundary-band filtering
/// is wrong (±1 count drift occurs even at mid-range phases, ~1%).
///
/// `ts_res_ns` is the phase step reported by the device
/// (`Capabilities.ts_res_ns`); the SDK has no resolution constant (R-TS3).
pub fn candidates(count: u32, phase: u8, ts_res_ns: u32) -> [i64; 3] {
    let base = as_is_ns(count, phase, ts_res_ns);
    [base, base - 1000, base + 1000]
}

/// Naive (uncorrected) ns value for one event: `count * 1000 + phase *
/// ts_res_ns`.
pub fn as_is_ns(count: u32, phase: u8, ts_res_ns: u32) -> i64 {
    i64::from(count) * 1000 + i64::from(phase) * i64::from(ts_res_ns)
}

fn pairwise_score(values: &[i64]) -> i64 {
    let mut sum = 0;
    for i in 0..values.len() {
        for j in (i + 1)..values.len() {
            sum += (values[i] - values[j]).abs();
        }
    }
    sum
}

/// Reconcile K events assumed to share one physical instant.
///
/// Returns one ns value per input event. K=1 and K>MAX_EXHAUSTIVE_K return
/// as-is values (no correction possible / search too large). Ties prefer
/// as-is candidates (combination index 0 is all as-is and wins on equality).
pub fn reconcile(events: &[(u32, u8)], ts_res_ns: u32) -> Vec<i64> {
    let k = events.len();
    if k == 0 {
        return Vec::new();
    }
    let cands: Vec<[i64; 3]> = events
        .iter()
        .map(|&(c, p)| candidates(c, p, ts_res_ns))
        .collect();
    if k == 1 || k > MAX_EXHAUSTIVE_K {
        return cands.iter().map(|c| c[0]).collect();
    }

    let total = 3usize.pow(k as u32);
    let mut best_combo = 0usize;
    let mut best_score = i64::MAX;
    let mut values = vec![0i64; k];
    for combo in 0..total {
        let mut rem = combo;
        for (i, v) in values.iter_mut().enumerate() {
            *v = cands[i][rem % 3];
            rem /= 3;
        }
        let score = pairwise_score(&values);
        if score < best_score {
            best_score = score;
            best_combo = combo;
        }
    }

    let mut rem = best_combo;
    (0..k)
        .map(|i| {
            let v = cands[i][rem % 3];
            rem /= 3;
            v
        })
        .collect()
}

/// Extends u32 raw counts (wrap ~71.6 min) to u64 by tracking wraps.
/// One independent instance per device (per count source).
pub struct CountExtender {
    high: u32,
    last_raw: u32,
}

impl CountExtender {
    pub fn new() -> Self {
        Self {
            high: 0,
            last_raw: 0,
        }
    }

    pub fn extend(&mut self, raw: u32) -> u64 {
        if raw < self.last_raw {
            self.high += 1;
        }
        self.last_raw = raw;
        ((self.high as u64) << 32) | raw as u64
    }
}

impl Default for CountExtender {
    fn default() -> Self {
        Self::new()
    }
}

/// One timestamp event tagged with its origin (device × channel).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceEvent {
    /// Device identifier (UID or "local" for single-device use).
    pub device: String,
    /// Channel label, e.g. "GP0" (best-effort, derived from inputs diff).
    pub channel: String,
    pub inputs: String,
    pub raw_count: u32,
    pub raw_phase: u8,
    pub sync_active: bool,
}

impl SourceEvent {
    pub fn source_label(&self) -> String {
        if self.device.is_empty() || self.device == "local" {
            self.channel.clone()
        } else {
            format!("{}:{}", self.device, self.channel)
        }
    }
}

/// A group of events attributed to the same physical instant, with
/// reconciled ns values.
#[derive(Debug, Clone, Serialize)]
pub struct ReconcileGroup {
    pub approx_count: u32,
    pub events: Vec<SourceEvent>,
    pub reconciled_ns: Vec<i64>,
    /// true when a cross-event correction was actually applied (K≥2 and
    /// comparable time bases).
    pub reconciled: bool,
    pub warning: Option<String>,
}

/// Group events by count proximity and reconcile within each group.
///
/// Grouping rule: all raw_counts within a group are mutually within ±1;
/// a count gap ≥2 starts a new group. Within a group:
/// - K=1 → as-is (no correction possible)
/// - mixed sync_active → as-is + warning (incomparable time bases)
/// - sync_active=0 across different devices → as-is + warning
///   (independent TIMER0 bases)
/// - K>MAX_EXHAUSTIVE_K → as-is + warning
///
/// `ts_res_ns` is `Capabilities.ts_res_ns`. A free-running event
/// (`sync_active = false`) has no phase: its ns value is `count * 1000`.
pub fn group_events(events: &[SourceEvent], ts_res_ns: u32) -> Vec<ReconcileGroup> {
    let mut sorted: Vec<&SourceEvent> = events.iter().collect();
    sorted.sort_by_key(|e| (e.raw_count, e.raw_phase));

    let mut groups = Vec::new();
    let mut current: Vec<SourceEvent> = Vec::new();
    for ev in sorted {
        if let Some(first) = current.first() {
            // first has the minimum count in the group (sorted input),
            // so this keeps max-min ≤ 1 for all members.
            if ev.raw_count - first.raw_count >= 2 {
                groups.push(finish_group(std::mem::take(&mut current), ts_res_ns));
            }
        }
        current.push(ev.clone());
    }
    if !current.is_empty() {
        groups.push(finish_group(current, ts_res_ns));
    }
    groups
}

fn finish_group(events: Vec<SourceEvent>, ts_res_ns: u32) -> ReconcileGroup {
    let approx_count = events.first().map(|e| e.raw_count).unwrap_or(0);
    let k = events.len();

    // R-TS1: without sync the phase is always 0, so the ns value is the
    // count alone.
    let pairs: Vec<(u32, u8)> = events
        .iter()
        .map(|e| (e.raw_count, if e.sync_active { e.raw_phase } else { 0 }))
        .collect();
    let as_is: Vec<i64> = pairs
        .iter()
        .map(|&(c, p)| as_is_ns(c, p, ts_res_ns))
        .collect();

    let sync_states: std::collections::HashSet<bool> =
        events.iter().map(|e| e.sync_active).collect();
    let devices: std::collections::HashSet<&str> =
        events.iter().map(|e| e.device.as_str()).collect();

    let (reconciled_ns, reconciled, warning) = if k == 1 {
        (as_is, false, None)
    } else if sync_states.len() > 1 {
        (
            as_is,
            false,
            Some(
                "mixed sync_active in group; time bases incomparable, no correction applied"
                    .to_string(),
            ),
        )
    } else if !events[0].sync_active && devices.len() > 1 {
        (
            as_is,
            false,
            Some("sync_active=0 across different devices; independent TIMER0 bases, no correction applied".to_string()),
        )
    } else if k > MAX_EXHAUSTIVE_K {
        (
            as_is,
            false,
            Some(format!(
                "group size {k} exceeds exhaustive-search limit {MAX_EXHAUSTIVE_K}; no correction applied"
            )),
        )
    } else {
        (reconcile(&pairs, ts_res_ns), true, None)
    };

    ReconcileGroup {
        approx_count,
        events,
        reconciled_ns,
        reconciled,
        warning,
    }
}

/// Per-source-pair diff statistics across all reconciled groups.
#[derive(Debug, Clone, Serialize)]
pub struct PairStats {
    pub a: String,
    pub b: String,
    pub n: usize,
    pub mean_diff_ns: f64,
    pub stdev_ns: f64,
    pub max_abs_diff_ns: i64,
    pub within_500ns_pct: f64,
}

pub fn pair_stats(groups: &[ReconcileGroup]) -> Vec<PairStats> {
    use std::collections::BTreeMap;
    let mut diffs: BTreeMap<(String, String), Vec<i64>> = BTreeMap::new();

    for group in groups {
        for i in 0..group.events.len() {
            for j in (i + 1)..group.events.len() {
                let a = group.events[i].source_label();
                let b = group.events[j].source_label();
                let d = group.reconciled_ns[i] - group.reconciled_ns[j];
                let (key, d) = if a <= b { ((a, b), d) } else { ((b, a), -d) };
                diffs.entry(key).or_default().push(d);
            }
        }
    }

    diffs
        .into_iter()
        .map(|((a, b), ds)| {
            let n = ds.len();
            let mean = ds.iter().sum::<i64>() as f64 / n as f64;
            let var = ds.iter().map(|&d| (d as f64 - mean).powi(2)).sum::<f64>() / n as f64;
            let max_abs = ds.iter().map(|d| d.abs()).max().unwrap_or(0);
            let within = ds.iter().filter(|d| d.abs() <= 500).count() as f64 / n as f64 * 100.0;
            PairStats {
                a,
                b,
                n,
                mean_diff_ns: mean,
                stdev_ns: var.sqrt(),
                max_abs_diff_ns: max_abs,
                within_500ns_pct: within,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Capabilities.ts_res_ns of the v2 firmware.
    const TS_RES: u32 = 40;

    fn ev(device: &str, channel: &str, count: u32, phase: u8, sync: bool) -> SourceEvent {
        SourceEvent {
            device: device.to_string(),
            channel: channel.to_string(),
            inputs: "0x00000001".to_string(),
            raw_count: count,
            raw_phase: phase,
            sync_active: sync,
        }
    }

    // --- candidates ---

    #[test]
    fn candidates_basic() {
        assert_eq!(candidates(1000, 7, TS_RES), [1000280, 999280, 1001280]);
    }

    #[test]
    fn candidates_count_zero() {
        // count-1 goes negative; must not panic and stays ordered.
        assert_eq!(candidates(0, 7, TS_RES), [280, -720, 1280]);
    }

    #[test]
    fn candidates_phase_zero() {
        assert_eq!(candidates(1000, 0, TS_RES), [1000000, 999000, 1001000]);
    }

    #[test]
    fn candidates_phase_max() {
        assert_eq!(candidates(1000, 24, TS_RES), [1000960, 999960, 1001960]);
    }

    #[test]
    fn candidates_scale_with_the_resolution_argument() {
        // The phase step is the caller's Capabilities.ts_res_ns, not a constant.
        assert_eq!(candidates(1000, 7, 50), [1000350, 999350, 1001350]);
        assert_eq!(as_is_ns(1000, 7, 50), 1000350);
        assert_eq!(as_is_ns(1000, 7, 40), 1000280);
    }

    #[test]
    fn reconcile_uses_the_resolution_argument() {
        // Straddle pair: only the corrected values differ with the resolution.
        assert_eq!(
            reconcile(&[(1001, 2), (1000, 2)], 40),
            vec![1000080, 1000080]
        );
        assert_eq!(
            reconcile(&[(1001, 2), (1000, 2)], 50),
            vec![1000100, 1000100]
        );
    }

    #[test]
    fn group_events_ignores_the_phase_of_free_running_events() {
        // s=0: ns = count * 1000, whatever the phase field says (R-TS1).
        let events = vec![ev("local", "GP0", 1000, 9, false)];
        let groups = group_events(&events, TS_RES);
        assert_eq!(groups[0].reconciled_ns, vec![1_000_000]);
        // s=1: the resolution argument scales the phase.
        let events = vec![ev("local", "GP0", 1000, 9, true)];
        assert_eq!(group_events(&events, 50)[0].reconciled_ns, vec![1_000_450]);
    }

    #[test]
    fn source_has_no_phase_step_constant() {
        // R-TS3: the resolution comes from `caps`, never from a constant.
        let src = include_str!("reconcile.rs");
        let needle = ["PHASE", "STEP", "NS"].join("_");
        let code = src.split("#[cfg(test)]").next().unwrap();
        assert!(!code.contains(&needle));
    }

    // --- reconcile core ---

    #[test]
    fn reconcile_k1_single_as_is() {
        assert_eq!(reconcile(&[(1000, 7)], TS_RES), vec![1000280]);
    }

    #[test]
    fn reconcile_k2_no_crossing() {
        // Both as-is values are already close; no shift should win.
        let r = reconcile(&[(1000, 7), (1000, 9)], TS_RES);
        assert_eq!(r, vec![1000280, 1000360]);
    }

    #[test]
    fn reconcile_k2_count_minus_1() {
        // Physical instant ~1000080ns: device A latched count after the
        // edge (count=1001, phase=2 → naive 1001080), device B before
        // (count=1000, phase=2 → 1000080). A's count-1 candidate matches.
        let r = reconcile(&[(1001, 2), (1000, 2)], TS_RES);
        assert_eq!(r, vec![1000080, 1000080]);
    }

    #[test]
    fn reconcile_k2_count_plus_1() {
        // Mirror case: device A under-counted by 1.
        let r = reconcile(&[(999, 23), (1000, 23)], TS_RES);
        assert_eq!(r, vec![1000920, 1000920]);
    }

    #[test]
    fn reconcile_k2_both_shifted() {
        // Both events straddle in opposite directions around the 1000µs
        // boundary: naive diff is 1080ns. Two combinations tie at 80ns
        // ((count-1, as-is) and (as-is, count+1)); enumeration order picks
        // the first. Either way the corrected diff is ≤ 100ns.
        let r = reconcile(&[(1001, 1), (999, 24)], TS_RES);
        assert_eq!(r, vec![1000040, 999960]);
        assert!((r[0] - r[1]).abs() <= 100);
    }

    #[test]
    fn reconcile_k3_three_sources() {
        // 3 sources (3 devices or 1 device × 3ch); the middle event
        // latched count after the µs edge → count-1 restores it.
        let r = reconcile(&[(1000, 1), (1001, 1), (1000, 2)], TS_RES);
        assert_eq!(r, vec![1000040, 1000040, 1000080]);
    }

    #[test]
    fn reconcile_k4_four_sources() {
        // 2 devices × 2ch around ~1000.9µs; one device latched count after
        // the µs edge (1001, 1) — its count-1 candidate (1000040ns) is NOT
        // chosen because as-is (1001040ns) is closer to the other three.
        let r = reconcile(&[(1000, 23), (1001, 1), (1000, 24), (1000, 22)], TS_RES);
        assert_eq!(r, vec![1000920, 1001040, 1000960, 1000880]);
        // One event straddled high: physical instant ~999.9µs but one
        // device latched count=1000 with phase=24 → count-1 restores it.
        let r2 = reconcile(&[(999, 24), (1000, 24), (999, 23), (999, 22)], TS_RES);
        assert_eq!(r2, vec![999960, 999960, 999920, 999880]);
    }

    #[test]
    fn reconcile_tie_prefers_as_is() {
        // Identical events: every combination that shifts all equally has
        // score 0, but the all-as-is combination is found first.
        let r = reconcile(&[(1000, 7), (1000, 7)], TS_RES);
        assert_eq!(r, vec![1000280, 1000280]);
    }

    #[test]
    fn reconcile_k_too_large_falls_back_to_as_is() {
        let events: Vec<(u32, u8)> = (0..9).map(|_| (1000, 7)).collect();
        let r = reconcile(&events, TS_RES);
        assert_eq!(r, vec![1000280; 9]);
    }

    // --- CountExtender ---

    #[test]
    fn count_extender_no_wrap() {
        let mut ext = CountExtender::new();
        assert_eq!(ext.extend(100), 100);
        assert_eq!(ext.extend(200), 200);
        assert_eq!(ext.extend(200), 200);
    }

    #[test]
    fn count_extender_wrap() {
        let mut ext = CountExtender::new();
        assert_eq!(ext.extend(0xFFFF_FFF0), 0xFFFF_FFF0);
        assert_eq!(ext.extend(5), 0x1_0000_0005);
        assert_eq!(ext.extend(10), 0x1_0000_000A);
    }

    // --- grouping / pairing ---

    #[test]
    fn pair_events_same_device_2ch() {
        let events = vec![
            ev("local", "GP0", 1000, 23, true),
            ev("local", "GP1", 1001, 2, true),
        ];
        let groups = group_events(&events, TS_RES);
        assert_eq!(groups.len(), 1);
        assert!(groups[0].reconciled);
        assert_eq!(groups[0].events.len(), 2);
    }

    #[test]
    fn pair_events_2devices_1ch() {
        let events = vec![
            ev("devA", "GP0", 1000, 17, true),
            ev("devB", "GP0", 1000, 5, true),
        ];
        let groups = group_events(&events, TS_RES);
        assert_eq!(groups.len(), 1);
        assert!(groups[0].reconciled);
    }

    #[test]
    fn pair_events_2devices_2ch() {
        let events = vec![
            ev("devA", "GP0", 1000, 23, true),
            ev("devA", "GP1", 1001, 2, true),
            ev("devB", "GP0", 1000, 17, true),
            ev("devB", "GP1", 1001, 5, true),
        ];
        let groups = group_events(&events, TS_RES);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].events.len(), 4);
        assert!(groups[0].reconciled);
    }

    #[test]
    fn pair_events_3devices_1ch() {
        let events = vec![
            ev("devA", "GP0", 1000, 17, true),
            ev("devB", "GP0", 1000, 5, true),
            ev("devC", "GP0", 1001, 1, true),
        ];
        let groups = group_events(&events, TS_RES);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].events.len(), 3);
        assert!(groups[0].reconciled);
    }

    #[test]
    fn pair_events_count_gap_splits() {
        let events = vec![
            ev("devA", "GP0", 1000, 17, true),
            ev("devB", "GP0", 1000, 5, true),
            ev("devA", "GP0", 5000, 3, true),
            ev("devB", "GP0", 5001, 0, true),
            ev("devA", "GP0", 9000, 8, true),
        ];
        let groups = group_events(&events, TS_RES);
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].events.len(), 2);
        assert_eq!(groups[1].events.len(), 2);
        assert_eq!(groups[2].events.len(), 1);
        assert!(!groups[2].reconciled); // K=1: no correction possible
    }

    #[test]
    fn pair_events_missing_source() {
        // 3 sources expected but one missing → K=2 still reconciles.
        let events = vec![
            ev("devA", "GP0", 1000, 17, true),
            ev("devB", "GP0", 1001, 1, true),
        ];
        let groups = group_events(&events, TS_RES);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].events.len(), 2);
        assert!(groups[0].reconciled);
    }

    #[test]
    fn pair_events_sync_active_mismatch() {
        let events = vec![
            ev("devA", "GP0", 1000, 17, true),
            ev("devB", "GP0", 1000, 0, false),
        ];
        let groups = group_events(&events, TS_RES);
        assert_eq!(groups.len(), 1);
        assert!(!groups[0].reconciled);
        assert!(groups[0]
            .warning
            .as_deref()
            .unwrap()
            .contains("mixed sync_active"));
    }

    #[test]
    fn pair_events_timer0_cross_device_not_reconciled() {
        // sync_active=0 on different devices: independent TIMER0 bases.
        let events = vec![
            ev("devA", "GP0", 1000, 0, false),
            ev("devB", "GP0", 1000, 0, false),
        ];
        let groups = group_events(&events, TS_RES);
        assert!(!groups[0].reconciled);
        assert!(groups[0].warning.is_some());
    }

    #[test]
    fn pair_events_timer0_same_device_reconciled() {
        // sync_active=0 but same device: shared TIMER0, reconcile OK.
        let events = vec![
            ev("local", "GP0", 1000, 0, false),
            ev("local", "GP1", 1001, 0, false),
        ];
        let groups = group_events(&events, TS_RES);
        assert!(groups[0].reconciled);
    }

    #[test]
    fn pair_events_basic() {
        let events = vec![
            ev("devA", "GP0", 100, 5, true),
            ev("devB", "GP0", 100, 9, true),
        ];
        let groups = group_events(&events, TS_RES);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].approx_count, 100);
        assert_eq!(groups[0].reconciled_ns, vec![100200, 100360]);
    }

    #[test]
    fn pair_events_missing() {
        // Event counts differ between sources: extra event forms its own group.
        let events = vec![
            ev("devA", "GP0", 100, 5, true),
            ev("devB", "GP0", 100, 9, true),
            ev("devA", "GP0", 200, 2, true),
        ];
        let groups = group_events(&events, TS_RES);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[1].events.len(), 1);
    }

    #[test]
    fn pair_stats_basic() {
        let events = vec![
            ev("devA", "GP0", 1000, 10, true),
            ev("devB", "GP0", 1000, 5, true),
        ];
        let groups = group_events(&events, TS_RES);
        let stats = pair_stats(&groups);
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].n, 1);
        assert_eq!(stats[0].max_abs_diff_ns, 200);
        assert_eq!(stats[0].within_500ns_pct, 100.0);
    }
}
