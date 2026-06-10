"""Reconcile test vectors ported verbatim from the Rust reference
(`sdk/rust/src/reconcile.rs`); all SDKs must produce identical results."""

from pochi.reconcile import (
    CountExtender,
    SourceEvent,
    candidates,
    group_events,
    pair_stats,
    reconcile,
)


def ev(device: str, channel: str, count: int, phase: int, sync: bool) -> SourceEvent:
    return SourceEvent(
        device=device,
        channel=channel,
        inputs="0x00000001",
        raw_count=count,
        raw_phase=phase,
        sync_active=sync,
    )


class TestCandidates:
    def test_basic(self):
        assert candidates(1000, 7) == (1000280, 999280, 1001280)

    def test_count_zero(self):
        assert candidates(0, 7) == (280, -720, 1280)

    def test_phase_bounds(self):
        assert candidates(1000, 0) == (1000000, 999000, 1001000)
        assert candidates(1000, 24) == (1000960, 999960, 1001960)


class TestReconcile:
    def test_k1_as_is(self):
        assert reconcile([(1000, 7)]) == [1000280]

    def test_k2_no_crossing(self):
        assert reconcile([(1000, 7), (1000, 9)]) == [1000280, 1000360]

    def test_k2_count_minus_1(self):
        assert reconcile([(1001, 2), (1000, 2)]) == [1000080, 1000080]

    def test_k2_count_plus_1(self):
        assert reconcile([(999, 23), (1000, 23)]) == [1000920, 1000920]

    def test_k2_both_shifted(self):
        r = reconcile([(1001, 1), (999, 24)])
        assert r == [1000040, 999960]
        assert abs(r[0] - r[1]) <= 100

    def test_k3(self):
        assert reconcile([(1000, 1), (1001, 1), (1000, 2)]) == [
            1000040,
            1000040,
            1000080,
        ]

    def test_k4(self):
        assert reconcile([(1000, 23), (1001, 1), (1000, 24), (1000, 22)]) == [
            1000920,
            1001040,
            1000960,
            1000880,
        ]
        assert reconcile([(999, 24), (1000, 24), (999, 23), (999, 22)]) == [
            999960,
            999960,
            999920,
            999880,
        ]

    def test_tie_prefers_as_is(self):
        assert reconcile([(1000, 7), (1000, 7)]) == [1000280, 1000280]

    def test_k_too_large_as_is(self):
        assert reconcile([(1000, 7)] * 9) == [1000280] * 9


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
            [ev("local", "GP0", 1000, 23, True), ev("local", "GP1", 1001, 2, True)]
        )
        assert len(groups) == 1
        assert groups[0].reconciled
        assert len(groups[0].events) == 2

    def test_2devices_1ch(self):
        groups = group_events(
            [ev("devA", "GP0", 1000, 17, True), ev("devB", "GP0", 1000, 5, True)]
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
            ]
        )
        assert [len(g.events) for g in groups] == [2, 2, 1]
        assert not groups[2].reconciled  # K=1

    def test_mixed_sync_uncorrected(self):
        groups = group_events(
            [ev("devA", "GP0", 1000, 17, True), ev("devB", "GP0", 1000, 0, False)]
        )
        assert not groups[0].reconciled
        assert "mixed sync_active" in groups[0].warning

    def test_timer0_cross_device_uncorrected(self):
        groups = group_events(
            [ev("devA", "GP0", 1000, 0, False), ev("devB", "GP0", 1000, 0, False)]
        )
        assert not groups[0].reconciled
        assert groups[0].warning is not None

    def test_timer0_same_device_reconciled(self):
        groups = group_events(
            [ev("local", "GP0", 1000, 0, False), ev("local", "GP1", 1001, 0, False)]
        )
        assert groups[0].reconciled

    def test_basic_ns(self):
        groups = group_events(
            [ev("devA", "GP0", 100, 5, True), ev("devB", "GP0", 100, 9, True)]
        )
        assert groups[0].approx_count == 100
        assert groups[0].reconciled_ns == [100200, 100360]


class TestPairStats:
    def test_basic(self):
        groups = group_events(
            [ev("devA", "GP0", 1000, 10, True), ev("devB", "GP0", 1000, 5, True)]
        )
        stats = pair_stats(groups)
        assert len(stats) == 1
        assert stats[0].n == 1
        assert stats[0].max_abs_diff_ns == 200
        assert stats[0].within_500ns_pct == 100.0
