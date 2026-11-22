"""Reconcile test vectors ported verbatim from the Rust reference
(`sdk/rust/src/reconcile.rs`); all SDKs must produce identical results.

The phase resolution is an argument of every function that converts phase
to nanoseconds (``Capabilities.ts_res_ns``); no SDK defines a phase-step
constant (docs/sdk-api-design.md section 7).
"""

import inspect

import pytest

from tcapi import reconcile as reconcile_module
from tcapi.reconcile import (
    CountExtender,
    SourceEvent,
    as_is_ns,
    candidates,
    group_events,
    pair_stats,
    reconcile,
)
from tcapi.types import TimestampEvent

RES = 40  # Capabilities.ts_res_ns of the golden device


def ev(device: str, channel: str, count: int, phase: int, sync: bool) -> SourceEvent:
    return SourceEvent(
        device=device,
        channel=channel,
        inputs=0x00000001,
        raw_count=count,
        raw_phase=phase,
        sync_active=sync,
    )


class TestNoPhaseConstant:
    def test_module_has_no_phase_step_constant(self):
        assert not hasattr(reconcile_module, "PHASE_STEP_NS")

    @pytest.mark.parametrize("func", [candidates, as_is_ns, reconcile, group_events])
    def test_every_converter_takes_ts_res_ns(self, func):
        assert "ts_res_ns" in inspect.signature(func).parameters

    def test_ts_res_ns_is_required(self):
        with pytest.raises(TypeError):
            candidates(1000, 7)  # type: ignore[call-arg]
        with pytest.raises(TypeError):
            reconcile([(1000, 7)])  # type: ignore[call-arg]
        with pytest.raises(TypeError):
            group_events([])  # type: ignore[call-arg]

    def test_resolution_is_taken_from_the_argument(self):
        assert as_is_ns(1000, 7, 40) == 1000280
        assert as_is_ns(1000, 7, 25) == 1000175
        assert candidates(1000, 7, 25) == (1000175, 999175, 1001175)
        assert reconcile([(1000, 7), (1000, 9)], 25) == [1000175, 1000225]
        groups = group_events(
            [ev("devA", "GP0", 100, 5, True), ev("devB", "GP0", 100, 9, True)], 25
        )
        assert groups[0].reconciled_ns == [100125, 100225]


class TestCandidates:
    def test_basic(self):
        assert candidates(1000, 7, RES) == (1000280, 999280, 1001280)

    def test_count_zero(self):
        assert candidates(0, 7, RES) == (280, -720, 1280)

    def test_phase_bounds(self):
        assert candidates(1000, 0, RES) == (1000000, 999000, 1001000)
        assert candidates(1000, 24, RES) == (1000960, 999960, 1001960)


class TestReconcile:
    def test_empty(self):
        assert reconcile([], RES) == []

    def test_k1_as_is(self):
        assert reconcile([(1000, 7)], RES) == [1000280]

    def test_k2_no_crossing(self):
        assert reconcile([(1000, 7), (1000, 9)], RES) == [1000280, 1000360]

    def test_k2_count_minus_1(self):
        assert reconcile([(1001, 2), (1000, 2)], RES) == [1000080, 1000080]

    def test_k2_count_plus_1(self):
        assert reconcile([(999, 23), (1000, 23)], RES) == [1000920, 1000920]

    def test_k2_both_shifted(self):
        r = reconcile([(1001, 1), (999, 24)], RES)
        assert r == [1000040, 999960]
        assert abs(r[0] - r[1]) <= 100

    def test_k3(self):
        assert reconcile([(1000, 1), (1001, 1), (1000, 2)], RES) == [
            1000040,
            1000040,
            1000080,
        ]

    def test_k4(self):
        assert reconcile([(1000, 23), (1001, 1), (1000, 24), (1000, 22)], RES) == [
            1000920,
            1001040,
            1000960,
            1000880,
        ]
        assert reconcile([(999, 24), (1000, 24), (999, 23), (999, 22)], RES) == [
            999960,
            999960,
            999920,
            999880,
        ]

    def test_tie_prefers_as_is(self):
        assert reconcile([(1000, 7), (1000, 7)], RES) == [1000280, 1000280]

    def test_k_too_large_as_is(self):
        assert reconcile([(1000, 7)] * 9, RES) == [1000280] * 9


class TestCountExtender:
    def test_no_wrap(self):
        ext = CountExtender()
        assert ext.extend(100) == 100
        assert ext.extend(200) == 200
        assert ext.extend(200) == 200

    def test_wrap(self):
        ext = CountExtender()
        assert ext.extend(0xFFFFFFF0) == 0xFFFFFFF0
        assert ext.extend(5) == 0x1_0000_0005
        assert ext.extend(10) == 0x1_0000_000A


class TestGroupEvents:
    def test_same_device_2ch(self):
        groups = group_events(
            [ev("local", "GP0", 1000, 23, True), ev("local", "GP1", 1001, 2, True)],
            RES,
        )
        assert len(groups) == 1
        assert groups[0].reconciled
        assert len(groups[0].events) == 2

    def test_2devices_1ch(self):
        groups = group_events(
            [ev("devA", "GP0", 1000, 17, True), ev("devB", "GP0", 1000, 5, True)], RES
        )
        assert groups[0].reconciled

    def test_count_gap_splits(self):
        groups = group_events(
            [
                ev("devA", "GP0", 1000, 17, True),
                ev("devB", "GP0", 1000, 5, True),
                ev("devA", "GP0", 5000, 3, True),
                ev("devB", "GP0", 5001, 0, True),
                ev("devA", "GP0", 9000, 8, True),
            ],
            RES,
        )
        assert [len(g.events) for g in groups] == [2, 2, 1]
        assert not groups[2].reconciled  # K=1

    def test_mixed_sync_uncorrected(self):
        groups = group_events(
            [ev("devA", "GP0", 1000, 17, True), ev("devB", "GP0", 1000, 0, False)], RES
        )
        assert not groups[0].reconciled
        assert "mixed sync_active" in groups[0].warning

    def test_timer0_cross_device_uncorrected(self):
        groups = group_events(
            [ev("devA", "GP0", 1000, 0, False), ev("devB", "GP0", 1000, 0, False)], RES
        )
        assert not groups[0].reconciled
        assert groups[0].warning is not None

    def test_timer0_same_device_reconciled(self):
        groups = group_events(
            [ev("local", "GP0", 1000, 0, False), ev("local", "GP1", 1001, 0, False)],
            RES,
        )
        assert groups[0].reconciled

    def test_k_above_limit_uncorrected_with_warning(self):
        events = [ev("local", f"GP{i}", 1000, i, True) for i in range(9)]
        groups = group_events(events, RES)
        assert len(groups) == 1 and not groups[0].reconciled
        assert "exceeds" in groups[0].warning

    def test_basic_ns(self):
        groups = group_events(
            [ev("devA", "GP0", 100, 5, True), ev("devB", "GP0", 100, 9, True)], RES
        )
        assert groups[0].approx_count == 100
        assert groups[0].reconciled_ns == [100200, 100360]

    def test_source_event_carries_logical_inputs_as_int(self):
        e = ev("devA", "GP26 (ch23)", 100, 5, True)
        assert e.inputs == 1
        assert e.source_label() == "devA:GP26 (ch23)"
        assert ev("local", "GP26 (ch23)", 1, 0, True).source_label() == "GP26 (ch23)"


class TestPairStats:
    def test_basic(self):
        groups = group_events(
            [ev("devA", "GP0", 1000, 10, True), ev("devB", "GP0", 1000, 5, True)], RES
        )
        stats = pair_stats(groups)
        assert len(stats) == 1
        assert stats[0].n == 1
        assert stats[0].max_abs_diff_ns == 200
        assert stats[0].within_500ns_pct == 100.0


class TestSyncActiveGate:
    """One definition of timestamp ns across SDKs: ``TimestampEvent.ns``
    (R-TS1). Free running, the phase is not a time and is ignored."""

    def test_as_is_ns_ignores_phase_when_sync_inactive(self):
        assert as_is_ns(1000, 7, RES, sync_active=False) == 1000000
        assert as_is_ns(1000, 7, RES, sync_active=True) == 1000280

    def test_as_is_ns_matches_timestamp_event_ns(self):
        for sync in (True, False):
            event = TimestampEvent(
                inputs=1, raw_count=1000, raw_phase=7, sync_active=sync
            )
            assert as_is_ns(1000, 7, RES, sync_active=sync) == event.ns(RES)

    def test_candidates_gated(self):
        assert candidates(1000, 7, RES, sync_active=False) == (
            1000000,
            999000,
            1001000,
        )

    def test_reconcile_gated(self):
        assert reconcile([(1000, 7)], RES, sync_active=False) == [1000000]

    def test_group_events_single_device_free_running_ignores_phase(self):
        groups = group_events([ev("local", "GP0", 1000, 7, False)], RES)
        assert groups[0].reconciled_ns == [1000000]

    def test_group_events_mixed_sync_uses_gate_per_event(self):
        groups = group_events(
            [ev("devA", "GP0", 1000, 7, True), ev("devB", "GP0", 1000, 7, False)],
            RES,
        )
        assert groups[0].reconciled_ns == [1000280, 1000000]
        assert not groups[0].reconciled
