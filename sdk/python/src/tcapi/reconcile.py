"""Host-side timestamp reconciliation. Direct port of
``sdk/rust/src/reconcile.rs`` (itself from tcapi-cli); must produce
identical results for the shared test vectors.

The phase resolution is an **argument** (``ts_res_ns``, from
``Capabilities.ts_res_ns``) of every function that converts phase to
nanoseconds. No phase-step constant exists in the SDK.

The device sends raw ``(count, phase)`` pairs. Because the three DMA
channels (snapshot / count / phase) latch tens of ns apart, count and
phase can straddle a µs boundary within one event (~8%). Reconciliation
picks, for K events assumed to share one physical instant, the
combination of candidate ns values that minimizes total pairwise |diff|.
"""

from __future__ import annotations

from dataclasses import dataclass

from .types import timestamp_ns

#: Exhaustive search limit: 3^8 = 6561 combinations.
MAX_EXHAUSTIVE_K = 8


def as_is_ns(count: int, phase: int, ts_res_ns: int, sync_active: bool = True) -> int:
    """Naive (uncorrected) ns value for one event. Goes through
    :func:`tcapi.types.timestamp_ns`, so free running (``sync_active``
    False) the phase is ignored exactly as in ``TimestampEvent.ns``."""
    return timestamp_ns(count, phase, sync_active, ts_res_ns)


def candidates(
    count: int, phase: int, ts_res_ns: int, sync_active: bool = True
) -> tuple[int, int, int]:
    """The three physically possible ns values for one event:
    ``(as-is, count-1, count+1)``. Always all three — boundary-band
    filtering is wrong (±1 count drift occurs even at mid-range phases).
    """
    base = as_is_ns(count, phase, ts_res_ns, sync_active)
    return (base, base - 1000, base + 1000)


def _pairwise_score(values: list[int]) -> int:
    total = 0
    for i in range(len(values)):
        for j in range(i + 1, len(values)):
            total += abs(values[i] - values[j])
    return total


def reconcile(
    events: list[tuple[int, int]], ts_res_ns: int, sync_active: bool = True
) -> list[int]:
    """Reconcile K events assumed to share one physical instant.

    Returns one ns value per input event. K=1 and K>MAX_EXHAUSTIVE_K
    return as-is values. Ties prefer as-is candidates (combination 0
    wins on equality).
    """
    k = len(events)
    if k == 0:
        return []
    cands = [candidates(c, p, ts_res_ns, sync_active) for c, p in events]
    if k == 1 or k > MAX_EXHAUSTIVE_K:
        return [c[0] for c in cands]

    best_combo = 0
    best_score: int | None = None
    values = [0] * k
    for combo in range(3**k):
        rem = combo
        for i in range(k):
            values[i] = cands[i][rem % 3]
            rem //= 3
        score = _pairwise_score(values)
        if best_score is None or score < best_score:
            best_score = score
            best_combo = combo

    result = []
    rem = best_combo
    for i in range(k):
        result.append(cands[i][rem % 3])
        rem //= 3
    return result


class CountExtender:
    """Extends u32 raw counts (wrap ~71.6 min) to 64 bits by tracking
    wraps. One independent instance per device per count source."""

    def __init__(self) -> None:
        self._high = 0
        self._last_raw = 0

    def extend(self, raw: int) -> int:
        if raw < self._last_raw:
            self._high += 1
        self._last_raw = raw
        return (self._high << 32) | raw


@dataclass
class SourceEvent:
    """One timestamp event tagged with its origin (device x channel)."""

    #: Device identifier (UID or "local" for single-device use).
    device: str
    #: Channel label, e.g. ``pin_label(26)`` = "GP26 (ch23)".
    channel: str
    #: Logical input levels, physical GP bits.
    inputs: int
    raw_count: int
    raw_phase: int
    sync_active: bool

    def source_label(self) -> str:
        if self.device in ("", "local"):
            return self.channel
        return f"{self.device}:{self.channel}"


@dataclass
class ReconcileGroup:
    """A group of events attributed to the same physical instant."""

    approx_count: int
    events: list[SourceEvent]
    reconciled_ns: list[int]
    #: True when a cross-event correction was actually applied.
    reconciled: bool
    warning: str | None = None


def group_events(events: list[SourceEvent], ts_res_ns: int) -> list[ReconcileGroup]:
    """Group events by count proximity (gap >= 2 starts a new group) and
    reconcile within each group. Groups that cannot be corrected (K=1,
    mixed sync_active, sync_active=0 across devices, K too large) keep
    as-is values with a warning."""
    sorted_events = sorted(events, key=lambda e: (e.raw_count, e.raw_phase))

    groups: list[ReconcileGroup] = []
    current: list[SourceEvent] = []
    for ev in sorted_events:
        if current and ev.raw_count - current[0].raw_count >= 2:
            groups.append(_finish_group(current, ts_res_ns))
            current = []
        current.append(ev)
    if current:
        groups.append(_finish_group(current, ts_res_ns))
    return groups


def _finish_group(events: list[SourceEvent], ts_res_ns: int) -> ReconcileGroup:
    approx_count = events[0].raw_count if events else 0
    k = len(events)
    as_is = [
        as_is_ns(e.raw_count, e.raw_phase, ts_res_ns, e.sync_active) for e in events
    ]
    sync_states = {e.sync_active for e in events}
    devices = {e.device for e in events}

    if k == 1:
        reconciled_ns, reconciled, warning = as_is, False, None
    elif len(sync_states) > 1:
        reconciled_ns, reconciled, warning = (
            as_is,
            False,
            "mixed sync_active in group; time bases incomparable, no correction applied",
        )
    elif not events[0].sync_active and len(devices) > 1:
        reconciled_ns, reconciled, warning = (
            as_is,
            False,
            (
                "sync_active=0 across different devices; independent TIMER0 bases, "
                "no correction applied"
            ),
        )
    elif k > MAX_EXHAUSTIVE_K:
        reconciled_ns, reconciled, warning = (
            as_is,
            False,
            (
                f"group size {k} exceeds exhaustive-search limit {MAX_EXHAUSTIVE_K}; "
                "no correction applied"
            ),
        )
    else:
        pairs = [(e.raw_count, e.raw_phase) for e in events]
        reconciled_ns, reconciled, warning = (
            reconcile(pairs, ts_res_ns, events[0].sync_active),
            True,
            None,
        )

    return ReconcileGroup(approx_count, events, reconciled_ns, reconciled, warning)


@dataclass
class PairStats:
    """Per-source-pair diff statistics across all reconciled groups."""

    a: str
    b: str
    n: int
    mean_diff_ns: float
    stdev_ns: float
    max_abs_diff_ns: int
    within_500ns_pct: float


def pair_stats(groups: list[ReconcileGroup]) -> list[PairStats]:
    diffs: dict[tuple[str, str], list[int]] = {}

    for group in groups:
        for i in range(len(group.events)):
            for j in range(i + 1, len(group.events)):
                a = group.events[i].source_label()
                b = group.events[j].source_label()
                d = group.reconciled_ns[i] - group.reconciled_ns[j]
                if a > b:
                    a, b, d = b, a, -d
                diffs.setdefault((a, b), []).append(d)

    stats = []
    for (a, b), ds in sorted(diffs.items()):
        n = len(ds)
        mean = sum(ds) / n
        variance = sum((d - mean) ** 2 for d in ds) / n
        max_abs = max(abs(d) for d in ds)
        within = sum(1 for d in ds if abs(d) <= 500) / n * 100.0
        stats.append(
            PairStats(
                a=a,
                b=b,
                n=n,
                mean_diff_ns=mean,
                stdev_ns=variance**0.5,
                max_abs_diff_ns=max_abs,
                within_500ns_pct=within,
            )
        )
    return stats
