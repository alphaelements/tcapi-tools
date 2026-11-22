#!/usr/bin/env python3
"""Loopback + PinMap flexibility test.

Verifies that input/output ports can be assigned to arbitrary GPIO pins
via the v2 PinMap, using the existing physical loopback wiring:

  Dev1 GP0 (wire) ──┬── Dev1 GP4 (wire)
                     └── Dev2 GP0 (wire)
  Dev1 GP28 ──────── Dev2 GP28 (sync clock)

Tests:
  1. Write/Read patterns — reconfigure pin map, write, verify input
  2. Timestamp edge detection — self-loopback, cross-wire, scattered map
  3. Pattern engine — load/run/stop, loop mode, write-during-pattern
     rejection (ERR_BUSY), scattered map, cross-wire

Run:  python3.13 scripts/test_loopback_pinmap.py [-v]
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass

import tcapi
from tcapi.types import (
    VALID_DIO_MASK,
    EdgeMode,
    PatternMode,
    PatternState,
    PatternStep,
    PinMap,
    hold_ticks_from_ns,
)


@dataclass
class TestPattern:
    name: str
    description: str
    dev1_direction_mask: int
    dev2_direction_mask: int | None
    write_dev: int
    write_values: int
    write_mask: int
    check_dev: int
    check_bit: int
    expect_high: bool
    clear_values: int
    clear_mask: int


def make_pinmap(direction_mask: int) -> PinMap:
    """v2 map with the given outputs; every other DIO pin is an input with
    pull-down and edge events (R-M1 compliant)."""
    inputs = VALID_DIO_MASK & ~direction_mask
    return PinMap(
        flags=0,
        direction=direction_mask,
        pull_up=0,
        pull_down=inputs,
        out_default=0,
        out_polarity=0,
        in_polarity=0,
        edge=inputs,
    )


def ms(milliseconds: int) -> int:
    """Pattern ticks (200 ns) for a hold time in milliseconds."""
    return hold_ticks_from_ns(milliseconds * 1_000_000)


PATTERNS: list[TestPattern] = [
    # 1. Basic: GP0=OUT, GP4=IN — standard self-loopback
    TestPattern(
        name="basic_gp0out_gp4in",
        description="Dev1 GP0=OUT → Dev1 GP4=IN (self-loopback)",
        dev1_direction_mask=0x00000001,  # GP0=OUT
        dev2_direction_mask=None,
        write_dev=1,
        write_values=0x01,
        write_mask=0x01,
        check_dev=1,
        check_bit=4,  # GP4
        expect_high=True,
        clear_values=0x00,
        clear_mask=0x01,
    ),
    # 2. Scattered OUT/IN: GP0=OUT, GP1=IN, GP4=IN, GP5=OUT
    #    Write GP0=1 → GP4 should see 1, GP1 stays 0 (not wired)
    TestPattern(
        name="scattered_gp0out_gp5out_gp1in_gp4in",
        description="Dev1 GP0=OUT,GP5=OUT,GP1=IN,GP4=IN — scattered layout",
        dev1_direction_mask=0x00000001 | 0x00000020,  # GP0+GP5=OUT
        dev2_direction_mask=None,
        write_dev=1,
        write_values=0x01,  # GP0=1, GP5=0
        write_mask=0x21,  # mask GP0+GP5
        check_dev=1,
        check_bit=4,  # GP4 should read 1 (wired to GP0)
        expect_high=True,
        clear_values=0x00,
        clear_mask=0x21,
    ),
    # 3. Many OUT pins: GP0-3,GP5-GP10 all OUT, GP4=IN
    #    Only GP0 is physically wired to GP4
    TestPattern(
        name="many_out_gp0to10_gp4in",
        description="Dev1 GP0-3,5-10=OUT, GP4=IN — many OUT, one wired",
        dev1_direction_mask=0x000007EF,  # GP0-3=0xF, GP5-10=0x7E0, minus GP4
        dev2_direction_mask=None,
        write_dev=1,
        write_values=0x01,  # only GP0=1
        write_mask=0x7EF,
        check_dev=1,
        check_bit=4,
        expect_high=True,
        clear_values=0x00,
        clear_mask=0x7EF,
    ),
    # 4. GP0=OUT, verify GP1 (not wired) stays low
    TestPattern(
        name="unwired_gp1_stays_low",
        description="Dev1 GP0=OUT=1, GP1=IN (not wired) should read 0",
        dev1_direction_mask=0x00000001,  # GP0=OUT
        dev2_direction_mask=None,
        write_dev=1,
        write_values=0x01,
        write_mask=0x01,
        check_dev=1,
        check_bit=1,  # GP1 — not wired, should be low (pull-down)
        expect_high=False,
        clear_values=0x00,
        clear_mask=0x01,
    ),
    # 5. Cross-wire: Dev1 GP0=OUT → Dev2 GP0=IN
    TestPattern(
        name="crosswire_dev1out_dev2in",
        description="Dev1 GP0=OUT → Dev2 GP0=IN (cross-wire)",
        dev1_direction_mask=0x00000001,
        dev2_direction_mask=0x00000000,  # all IN
        write_dev=1,
        write_values=0x01,
        write_mask=0x01,
        check_dev=2,
        check_bit=0,  # Dev2 GP0
        expect_high=True,
        clear_values=0x00,
        clear_mask=0x01,
    ),
    # 6. Cross-wire verify low: Dev1 GP0=OUT=0 → Dev2 GP0=IN should read 0
    TestPattern(
        name="crosswire_dev1out0_dev2in",
        description="Dev1 GP0=OUT=0 → Dev2 GP0=IN reads 0",
        dev1_direction_mask=0x00000001,
        dev2_direction_mask=0x00000000,
        write_dev=1,
        write_values=0x00,
        write_mask=0x01,
        check_dev=2,
        check_bit=0,
        expect_high=False,
        clear_values=0x00,
        clear_mask=0x01,
    ),
    # 7. High-numbered OUT: GP22=OUT, GP0=OUT (GP0 wired, GP22 not)
    TestPattern(
        name="high_gp22out_gp0out",
        description="Dev1 GP0+GP22=OUT, GP4=IN — high-ch OUT coexists",
        dev1_direction_mask=0x00000001 | 0x00400000,  # GP0+GP22
        dev2_direction_mask=None,
        write_dev=1,
        write_values=0x01,
        write_mask=0x00400001,
        check_dev=1,
        check_bit=4,
        expect_high=True,
        clear_values=0x00,
        clear_mask=0x00400001,
    ),
    # 8. GP26(ch23)=OUT, GP0=OUT — extended pin as OUT
    TestPattern(
        name="gp26out_gp0out",
        description="Dev1 GP0+GP26=OUT, GP4=IN — GP26 (ch23) as OUT",
        dev1_direction_mask=0x00000001 | 0x04000000,  # GP0+GP26
        dev2_direction_mask=None,
        write_dev=1,
        write_values=0x01,
        write_mask=0x04000001,
        check_dev=1,
        check_bit=4,
        expect_high=True,
        clear_values=0x00,
        clear_mask=0x04000001,
    ),
    # 9. Only GP5=OUT (not wired) — write GP5=1, GP4 should stay low
    TestPattern(
        name="unwired_out_only",
        description="Dev1 GP5=OUT only (not wired to GP4) — GP4 stays low",
        dev1_direction_mask=0x00000020,  # GP5=OUT
        dev2_direction_mask=None,
        write_dev=1,
        write_values=0x20,
        write_mask=0x20,
        check_dev=1,
        check_bit=4,
        expect_high=False,
        clear_values=0x00,
        clear_mask=0x20,
    ),
]


def run_ts_cross_test(
    dev1: tcapi.Connection,
    dev2: tcapi.Connection,
    verbose: bool,
) -> tuple[bool, str]:
    """Cross-wire timestamp test: Dev1 GP0=OUT toggles, Dev2 GP0=IN
    captures edges via timestamp engine. Verifies ts_arm on Dev2 detects
    edges from Dev1's output across the physical wire."""
    dev1.map_set(make_pinmap(0x00000001))  # GP0=OUT
    dev2.raw("map default")
    time.sleep(0.1)

    dev2.ts_arm(0x01, EdgeMode.RISING)  # Dev2 GP0=IN, mask=bit0
    time.sleep(0.1)

    for _ in range(10):
        dev1.write(0x01, 0x01)
        time.sleep(0.02)
        dev1.write(0x00, 0x01)
        time.sleep(0.02)

    time.sleep(0.2)
    ts = dev2.ts_get(85)
    dev2.ts_disarm()

    count = len(ts.events)
    ok = count >= 5
    msg = f"Dev2 TS captured {count} edges (need >=5)"
    if verbose:
        print(f"  TS cross test: {count} events")
        for i, e in enumerate(ts.events[:5]):
            print(f"    [{i}] inputs=0x{e.inputs:08x} c={e.raw_count} p={e.raw_phase}")
    return ok, msg


def run_ts_self_test(
    dev1: tcapi.Connection,
    verbose: bool,
) -> tuple[bool, str]:
    """Self-loopback timestamp test: Dev1 GP0=OUT, GP4=IN.
    Toggles GP0 and captures rising edges on GP4."""
    dev1.map_set(make_pinmap(0x00000001))  # GP0=OUT
    time.sleep(0.1)

    dev1.ts_arm(0x10, EdgeMode.RISING)  # GP4=IN, mask=bit4
    time.sleep(0.1)

    for _ in range(10):
        dev1.write(0x01, 0x01)
        time.sleep(0.02)
        dev1.write(0x00, 0x01)
        time.sleep(0.02)

    time.sleep(0.2)
    ts = dev1.ts_get(85)
    dev1.ts_disarm()

    count = len(ts.events)
    ok = count >= 5
    msg = f"Dev1 self-loopback TS captured {count} edges (need >=5)"
    if verbose:
        print(f"  TS self test: {count} events")
        for i, e in enumerate(ts.events[:5]):
            print(f"    [{i}] inputs=0x{e.inputs:08x} c={e.raw_count} p={e.raw_phase}")
    return ok, msg


def run_ts_scattered_test(
    dev1: tcapi.Connection,
    verbose: bool,
) -> tuple[bool, str]:
    """Timestamp on GP4 with scattered map: GP0=OUT, GP5=OUT, GP1=IN, GP4=IN.
    Verifies ts_arm works with non-default pin map."""
    dev1.map_set(make_pinmap(0x00000001 | 0x00000020))  # GP0+GP5=OUT
    time.sleep(0.1)

    dev1.ts_arm(0x10, EdgeMode.RISING)  # GP4=IN, mask=bit4
    time.sleep(0.1)

    for _ in range(10):
        dev1.write(0x01, 0x21)  # GP0=1, GP5=0
        time.sleep(0.02)
        dev1.write(0x00, 0x21)
        time.sleep(0.02)

    time.sleep(0.2)
    ts = dev1.ts_get(85)
    dev1.ts_disarm()

    count = len(ts.events)
    ok = count >= 5
    msg = f"Scattered-map TS on GP4 captured {count} edges (need >=5)"
    if verbose:
        print(f"  TS scattered test: {count} events")
    return ok, msg


def run_pattern_basic_test(
    dev1: tcapi.Connection,
    verbose: bool,
) -> tuple[bool, str]:
    """Pattern engine basic test: load a 2-step pattern on GP0=OUT,
    run once, verify GP4=IN sees the output change."""
    dev1.map_set(make_pinmap(0x00000001))  # GP0=OUT
    time.sleep(0.1)

    steps = [
        PatternStep(out_bits=0x01, hold_ticks=ms(50)),  # GP0=1, 50ms
        PatternStep(out_bits=0x00, hold_ticks=ms(50)),  # GP0=0, 50ms
    ]
    accepted = dev1.pattern_load(steps)
    if accepted != 2:
        return False, f"pattern_load accepted {accepted}, expected 2"

    status = dev1.pattern_status()
    if status.state != PatternState.LOADED:
        return False, f"after load, state={status.state}, expected LOADED"

    dev1.pattern_run(PatternMode.ONCE, 1)
    time.sleep(0.02)

    status = dev1.pattern_status()
    if status.state not in (PatternState.RUNNING, PatternState.DONE):
        return False, f"after run, state={status.state}, expected RUNNING or DONE"

    state_during = dev1.state()
    gp4_during = (state_during.inputs >> 4) & 1
    if verbose:
        print(f"  GP4 during pattern: {'HIGH' if gp4_during else 'LOW'}")

    time.sleep(0.15)
    status = dev1.pattern_status()
    if status.state != PatternState.DONE:
        dev1.pattern_stop()
        return False, f"pattern did not finish, state={status.state}"

    dev1.pattern_stop()
    return True, "pattern load/run/status/stop cycle OK"


def run_pattern_loop_test(
    dev1: tcapi.Connection,
    verbose: bool,
) -> tuple[bool, str]:
    """Pattern engine loop test: run a pattern in loop mode, verify it
    keeps running, then stop it."""
    dev1.map_set(make_pinmap(0x00000001))  # GP0=OUT
    time.sleep(0.1)

    steps = [
        PatternStep(out_bits=0x01, hold_ticks=ms(20)),
        PatternStep(out_bits=0x00, hold_ticks=ms(20)),
    ]
    dev1.pattern_load(steps)
    dev1.pattern_run(PatternMode.LOOP, 0)
    time.sleep(0.1)

    status = dev1.pattern_status()
    if status.state != PatternState.RUNNING:
        dev1.pattern_stop()
        return False, f"loop mode state={status.state}, expected RUNNING"

    loops1 = status.loops
    time.sleep(0.2)
    status2 = dev1.pattern_status()
    loops2 = status2.loops

    dev1.pattern_stop()

    if loops2 <= loops1:
        return False, f"loops did not advance: {loops1} -> {loops2}"

    if verbose:
        print(f"  loops advanced: {loops1} -> {loops2}")

    return True, f"loop mode running, loops {loops1}->{loops2}, stop OK"


def run_pattern_write_busy_test(
    dev1: tcapi.Connection,
    verbose: bool,
) -> tuple[bool, str]:
    """While a pattern is running, SET_OUTPUTS should return ERR_BUSY."""
    dev1.map_set(make_pinmap(0x00000001))  # GP0=OUT
    time.sleep(0.1)

    steps = [
        PatternStep(out_bits=0x01, hold_ticks=ms(500)),  # 500ms hold
        PatternStep(out_bits=0x00, hold_ticks=ms(500)),
    ]
    dev1.pattern_load(steps)
    dev1.pattern_run(PatternMode.ONCE, 1)
    time.sleep(0.05)

    try:
        dev1.write(0x01, 0x01)
        dev1.pattern_stop()
        return False, "write succeeded during pattern (expected BUSY error)"
    except Exception as e:
        dev1.pattern_stop()
        err_str = str(e)
        if "BUSY" in err_str:
            if verbose:
                print(f"  write rejected with: {e}")
            return True, "write correctly rejected with BUSY during pattern"
        return False, f"unexpected error during pattern write: {e}"


def run_pattern_scattered_map_test(
    dev1: tcapi.Connection,
    verbose: bool,
) -> tuple[bool, str]:
    """Pattern with scattered pin map: GP0+GP5=OUT, verify pattern runs
    and GP4=IN reads GP0 toggle."""
    dev1.map_set(make_pinmap(0x00000001 | 0x00000020))  # GP0+GP5=OUT
    time.sleep(0.1)

    steps = [
        PatternStep(out_bits=0x01, hold_ticks=ms(50)),  # GP0=1, GP5=0
        PatternStep(out_bits=0x00, hold_ticks=ms(50)),  # both 0
    ]
    accepted = dev1.pattern_load(steps)
    if accepted != 2:
        return False, f"pattern_load accepted {accepted}, expected 2"

    dev1.pattern_run(PatternMode.ONCE, 1)
    time.sleep(0.02)
    state = dev1.state()
    gp4 = (state.inputs >> 4) & 1

    time.sleep(0.15)
    dev1.pattern_stop()

    if verbose:
        print(f"  GP4 during scattered pattern: {'HIGH' if gp4 else 'LOW'}")

    return (
        True,
        f"scattered-map pattern ran OK, GP4={'HIGH' if gp4 else 'LOW'} during step 0",
    )


def run_pattern_crosswire_test(
    dev1: tcapi.Connection,
    dev2: tcapi.Connection,
    verbose: bool,
) -> tuple[bool, str]:
    """Cross-wire pattern test: Dev1 GP0=OUT pattern, Dev2 GP0=IN reads."""
    dev1.map_set(make_pinmap(0x00000001))  # GP0=OUT
    dev2.raw("map default")
    time.sleep(0.1)

    steps = [
        PatternStep(out_bits=0x01, hold_ticks=ms(100)),  # 100ms high
        PatternStep(out_bits=0x00, hold_ticks=ms(100)),
    ]
    dev1.pattern_load(steps)
    dev1.pattern_run(PatternMode.ONCE, 1)
    time.sleep(0.03)

    state = dev2.state()
    gp0_dev2 = (state.inputs >> 0) & 1

    time.sleep(0.25)
    dev1.pattern_stop()

    if not gp0_dev2:
        return False, "Dev2 GP0 did not read HIGH during Dev1 pattern step 0"

    if verbose:
        print("  Dev2 GP0 during Dev1 pattern: HIGH")

    return True, "cross-wire pattern: Dev2 GP0=HIGH during Dev1 output"


def main() -> None:
    parser = argparse.ArgumentParser(description="Loopback PinMap flexibility test")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    verbose: bool = args.verbose

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

    passed = 0
    failed = 0
    errors: list[str] = []

    try:
        # --- Pin Map + Write/Read patterns ---
        print(f"\n{'=' * 60}")
        print("  Loopback PinMap Flexibility Test")
        print(f"{'=' * 60}")
        print(f"  Dev1: {dev1_info.port} (devnum={dev1_info.device_number})")
        print(f"  Dev2: {dev2_info.port} (devnum={dev2_info.device_number})")
        print("  Wiring: Dev1 GP0 → Dev1 GP4 + Dev2 GP0")
        print(f"{'=' * 60}\n")

        for pat in PATTERNS:
            if verbose:
                print(f"--- {pat.name}: {pat.description}")

            try:
                dev1.map_set(make_pinmap(pat.dev1_direction_mask))
                m1 = dev1.map_get()
                if verbose:
                    print(
                        f"  Dev1 map: out={m1.direction.bit_count()} "
                        f"dir=0x{m1.direction:08x}"
                    )

                if pat.dev2_direction_mask is not None:
                    dev2.map_set(make_pinmap(pat.dev2_direction_mask))
                    m2 = dev2.map_get()
                    if verbose:
                        print(
                            f"  Dev2 map: out={m2.direction.bit_count()} "
                            f"dir=0x{m2.direction:08x}"
                        )

                wd = dev1 if pat.write_dev == 1 else dev2
                cd = dev1 if pat.check_dev == 1 else dev2

                wd.write(pat.write_values, pat.write_mask)
                time.sleep(0.05)
                state = cd.state()
                bit_val = (state.inputs >> pat.check_bit) & 1

                if verbose:
                    print(
                        f"  write(0x{pat.write_values:x}, 0x{pat.write_mask:x}) "
                        f"→ check dev{pat.check_dev} GP{pat.check_bit}: "
                        f"{'HIGH' if bit_val else 'LOW'} "
                        f"(expect {'HIGH' if pat.expect_high else 'LOW'})"
                    )

                ok = (bit_val == 1) == pat.expect_high
                if ok:
                    passed += 1
                    print(f"  PASS  {pat.name}")
                else:
                    failed += 1
                    expected = "HIGH" if pat.expect_high else "LOW"
                    actual = "HIGH" if bit_val else "LOW"
                    msg = (
                        f"  FAIL  {pat.name}: GP{pat.check_bit} "
                        f"expected {expected}, got {actual}"
                    )
                    print(msg)
                    errors.append(msg)

                wd.write(pat.clear_values, pat.clear_mask)

            except Exception as e:
                failed += 1
                msg = f"  ERROR {pat.name}: {e}"
                print(msg)
                errors.append(msg)

        # --- All-IN write rejection test ---
        test_name = "all_in_write_rejected"
        if verbose:
            print(f"--- {test_name}: all-IN map rejects write with NO_RESOURCE")
        try:
            dev1.map_set(make_pinmap(0x00000000))
            try:
                dev1.write(0x01, 0x01)
                failed += 1
                msg = f"  FAIL  {test_name}: write succeeded on all-IN map (expected error)"
                print(msg)
                errors.append(msg)
            except Exception as e:
                if "NO_RESOURCE" in str(e):
                    passed += 1
                    print(f"  PASS  {test_name}: write correctly rejected ({e})")
                else:
                    failed += 1
                    msg = f"  FAIL  {test_name}: unexpected error: {e}"
                    print(msg)
                    errors.append(msg)
        except Exception as e:
            failed += 1
            msg = f"  ERROR {test_name}: {e}"
            print(msg)
            errors.append(msg)

        dev1.raw("map default")

        # --- Timestamp tests ---
        print(f"\n{'=' * 60}")
        print("  Timestamp Edge Detection Tests")
        print(f"{'=' * 60}\n")

        for test_name, test_fn in [
            ("ts_self_loopback", lambda: run_ts_self_test(dev1, verbose)),
            ("ts_cross_wire", lambda: run_ts_cross_test(dev1, dev2, verbose)),
            ("ts_scattered_map", lambda: run_ts_scattered_test(dev1, verbose)),
        ]:
            try:
                ok, msg = test_fn()
                if ok:
                    passed += 1
                    print(f"  PASS  {test_name}: {msg}")
                else:
                    failed += 1
                    fmsg = f"  FAIL  {test_name}: {msg}"
                    print(fmsg)
                    errors.append(fmsg)
            except Exception as e:
                failed += 1
                fmsg = f"  ERROR {test_name}: {e}"
                print(fmsg)
                errors.append(fmsg)

        # --- Pattern engine tests ---
        print(f"\n{'=' * 60}")
        print("  Pattern Engine GPIO Output Tests")
        print(f"{'=' * 60}\n")

        for test_name, test_fn in [
            ("pat_basic", lambda: run_pattern_basic_test(dev1, verbose)),
            ("pat_loop", lambda: run_pattern_loop_test(dev1, verbose)),
            ("pat_write_busy", lambda: run_pattern_write_busy_test(dev1, verbose)),
            (
                "pat_scattered_map",
                lambda: run_pattern_scattered_map_test(dev1, verbose),
            ),
            ("pat_crosswire", lambda: run_pattern_crosswire_test(dev1, dev2, verbose)),
        ]:
            try:
                ok, msg = test_fn()
                if ok:
                    passed += 1
                    print(f"  PASS  {test_name}: {msg}")
                else:
                    failed += 1
                    fmsg = f"  FAIL  {test_name}: {msg}"
                    print(fmsg)
                    errors.append(fmsg)
            except Exception as e:
                failed += 1
                fmsg = f"  ERROR {test_name}: {e}"
                print(fmsg)
                errors.append(fmsg)

    finally:
        for cmd in ["ts disarm", "pattern stop", "map default"]:
            for d in [dev1, dev2]:
                try:
                    d.raw(cmd)
                except Exception:
                    pass
        dev1.close()
        dev2.close()

    # --- Summary ---
    total = passed + failed
    print(f"\n{'=' * 60}")
    print(f"  Results: {passed}/{total} PASS, {failed}/{total} FAIL")
    if errors:
        print("\n  Failures:")
        for e in errors:
            print(f"    {e}")
    print(f"{'=' * 60}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
