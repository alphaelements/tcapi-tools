#!/usr/bin/env python3
"""Two-device timestamp precision benchmark.

Requires two Tcapi-DIO devices connected with loopback + cross-wire:
  Dev1 GP0 (OUT) ──┬── Dev1 GP4 (IN)   [self-loopback]
                   └── Dev2 GP0 (IN)   [cross-wire]
  Dev1 GP28 ──────── Dev2 GP28         [sync clock]

Run:  python3.13 scripts/bench_2dev_precision.py
      (or via venv with pyserial installed)

Measures the sync-clock-based timestamp difference between two devices
observing the same physical edge. Specification (docs/40-pio-design.md §11.1):
  - |diff| <= 500ns: 100%
  - range: ±320ns
  - stdev: ~127ns

Exit code 0 = PASS, 1 = FAIL or insufficient data.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from dataclasses import asdict, dataclass

import tcapi
from tcapi.reconcile import SourceEvent, group_events


@dataclass
class BenchResult:
    pairs: int
    dev1_events: int
    dev2_events: int
    mean_diff_ns: float
    stdev_ns: float
    max_abs_diff_ns: int
    min_abs_diff_ns: int
    range_low_ns: int
    range_high_ns: int
    within_500ns_pct: float
    reconciled_count: int
    verdict: str


SPEC_MAX_DIFF_NS = 500
MIN_PAIRS_REQUIRED = 5


def run_benchmark(
    rounds: int = 10,
    toggles_per_round: int = 50,
    toggle_interval_s: float = 0.02,
    verbose: bool = False,
) -> BenchResult:
    devices = tcapi.discover()
    time.sleep(0.5)

    dev1_info = next((d for d in devices if d.device_number == 1), None)
    dev2_info = next((d for d in devices if d.device_number == 2), None)
    if not dev1_info or not dev2_info:
        found = [(d.device_number, d.port) for d in devices]
        print(f"ERROR: need devnum=1 and devnum=2, found: {found}", file=sys.stderr)
        sys.exit(1)

    dev1 = tcapi.Connection.open(dev1_info.port)
    dev2 = tcapi.Connection.open(dev2_info.port)

    try:
        return _run(dev1, dev2, rounds, toggles_per_round, toggle_interval_s, verbose)
    finally:
        for cmd in [
            "pattern stop",
            "ts disarm",
            "sync stop",
            "sync disarm",
            "map default",
        ]:
            for d in [dev1, dev2]:
                # Best-effort restore: keep going so the remaining commands
                # and both close() calls still run, but say what failed.
                try:
                    d.raw(cmd)
                except tcapi.SdkError as e:
                    print(f"cleanup {cmd!r} failed: {e}", file=sys.stderr)
        dev1.close()
        dev2.close()


def _run(
    dev1: tcapi.Connection,
    dev2: tcapi.Connection,
    rounds: int,
    toggles_per_round: int,
    toggle_interval_s: float,
    verbose: bool,
) -> BenchResult:
    inputs = tcapi.VALID_DIO_MASK & ~0x1
    out_map = tcapi.PinMap(
        flags=0,
        direction=0x1,  # GP0 output
        pull_up=0,
        pull_down=inputs,
        out_default=0,
        out_polarity=0,
        in_polarity=0,
        edge=inputs,
    )
    dev1.map_set(out_map)
    m = dev1.map_get()
    assert m.direction == 0x1, f"map set failed: dir={m.direction:#x}"
    ts_res_ns = dev1.caps().ts_res_ns

    dev1.sync_master()
    dev2.sync_arm()
    dev1.sync_start()
    time.sleep(1.0)

    c1 = dev1.sync_count()
    c2 = dev2.sync_count()
    if verbose:
        print(f"Sync counts: Dev1={c1} Dev2={c2} diff={abs(c1 - c2)}")

    dev1.ts_arm(0x10, tcapi.EdgeMode.RISING)
    dev2.ts_arm(0x01, tcapi.EdgeMode.RISING)

    all_dev1 = []
    all_dev2 = []

    for r in range(rounds):
        for _ in range(toggles_per_round):
            dev1.write(0x01, 0x01)
            time.sleep(toggle_interval_s)
            dev1.write(0x00, 0x01)
            time.sleep(toggle_interval_s)

        for _ in range(4):
            ts1 = dev1.ts_get(85)
            all_dev1.extend(ts1.events)
            ts2 = dev2.ts_get(85)
            all_dev2.extend(ts2.events)
            if not ts1.events and not ts2.events:
                break

        if verbose:
            print(
                f"  Round {r + 1}/{rounds}: Dev1={len(all_dev1)} Dev2={len(all_dev2)}"
            )

    all_src: list[SourceEvent] = []
    for e in all_dev1:
        all_src.append(
            SourceEvent(
                device="Dev1",
                channel=tcapi.pin_label(4),
                inputs=e.inputs,
                raw_count=e.raw_count,
                raw_phase=e.raw_phase,
                sync_active=e.sync_active,
            )
        )
    for e in all_dev2:
        all_src.append(
            SourceEvent(
                device="Dev2",
                channel=tcapi.pin_label(0),
                inputs=e.inputs,
                raw_count=e.raw_count,
                raw_phase=e.raw_phase,
                sync_active=e.sync_active,
            )
        )

    groups = group_events(all_src, ts_res_ns)
    paired = [g for g in groups if len(g.events) == 2]

    diffs_ns: list[int] = []
    reconciled_count = 0
    for g in paired:
        d = g.reconciled_ns[0] - g.reconciled_ns[1]
        diffs_ns.append(d)
        if g.reconciled:
            reconciled_count += 1

    if verbose:
        print(f"\nTotal: Dev1={len(all_dev1)} Dev2={len(all_dev2)}")
        print(f"Groups: {len(groups)}, Paired: {len(paired)}")

    if len(diffs_ns) < MIN_PAIRS_REQUIRED:
        print(
            f"INSUFFICIENT DATA: only {len(diffs_ns)} pairs "
            f"(need >={MIN_PAIRS_REQUIRED})",
            file=sys.stderr,
        )
        return BenchResult(
            pairs=len(diffs_ns),
            dev1_events=len(all_dev1),
            dev2_events=len(all_dev2),
            mean_diff_ns=0,
            stdev_ns=0,
            max_abs_diff_ns=0,
            min_abs_diff_ns=0,
            range_low_ns=0,
            range_high_ns=0,
            within_500ns_pct=0,
            reconciled_count=reconciled_count,
            verdict="INSUFFICIENT_DATA",
        )

    abs_diffs = [abs(d) for d in diffs_ns]
    within_500 = (
        sum(1 for d in abs_diffs if d <= SPEC_MAX_DIFF_NS) / len(abs_diffs) * 100
    )

    pass_all_within = within_500 >= 99.9
    pass_max = max(abs_diffs) <= SPEC_MAX_DIFF_NS
    verdict = "PASS" if pass_all_within and pass_max else "FAIL"

    result = BenchResult(
        pairs=len(diffs_ns),
        dev1_events=len(all_dev1),
        dev2_events=len(all_dev2),
        mean_diff_ns=round(statistics.mean(diffs_ns), 1),
        stdev_ns=round(statistics.stdev(diffs_ns) if len(diffs_ns) > 1 else 0, 1),
        max_abs_diff_ns=max(abs_diffs),
        min_abs_diff_ns=min(abs_diffs),
        range_low_ns=min(diffs_ns),
        range_high_ns=max(diffs_ns),
        within_500ns_pct=round(within_500, 1),
        reconciled_count=reconciled_count,
        verdict=verdict,
    )

    if verbose:
        for i, (g, d) in enumerate(zip(paired, diffs_ns, strict=True)):
            e0, e1 = g.events
            rec = "REC" if g.reconciled else "raw"
            print(
                f"  [{i:3d}] {e0.device}(c={e0.raw_count},p={e0.raw_phase}) "
                f"<-> {e1.device}(c={e1.raw_count},p={e1.raw_phase}): "
                f"{d:+d}ns [{rec}]"
            )

    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="2-device timestamp precision benchmark"
    )
    parser.add_argument(
        "--rounds", type=int, default=10, help="number of toggle rounds (default 10)"
    )
    parser.add_argument(
        "--toggles", type=int, default=50, help="toggles per round (default 50)"
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=0.02,
        help="toggle interval in seconds (default 0.02)",
    )
    parser.add_argument("--json", action="store_true", help="output result as JSON")
    parser.add_argument("-v", "--verbose", action="store_true", help="verbose output")
    args = parser.parse_args()

    result = run_benchmark(
        rounds=args.rounds,
        toggles_per_round=args.toggles,
        toggle_interval_s=args.interval,
        verbose=args.verbose,
    )

    if args.json:
        print(json.dumps(asdict(result), indent=2))
    else:
        print(f"\n{'=' * 50}")
        print("  2-Device Timestamp Precision Benchmark")
        print(f"{'=' * 50}")
        print(f"  Events:        Dev1={result.dev1_events}  Dev2={result.dev2_events}")
        print(f"  Matched pairs: {result.pairs} ({result.reconciled_count} reconciled)")
        print(f"  Mean diff:     {result.mean_diff_ns:+.1f} ns")
        print(f"  Stdev:         {result.stdev_ns:.1f} ns")
        print(f"  Max |diff|:    {result.max_abs_diff_ns} ns")
        print(f"  Range:         [{result.range_low_ns}, {result.range_high_ns}] ns")
        print(f"  |diff|<=500ns: {result.within_500ns_pct:.1f}%")
        print(f"{'=' * 50}")
        print("  Spec:    |diff|<=500ns 100%, range ±320ns")
        print(f"  VERDICT: {result.verdict}")
        print(f"{'=' * 50}")

    sys.exit(0 if result.verdict == "PASS" else 1)


if __name__ == "__main__":
    main()
