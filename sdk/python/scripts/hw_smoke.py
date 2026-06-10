#!/usr/bin/env python3
"""Hardware smoke test — requires a connected Pochi-DIO device.
Run: .venv/bin/python scripts/hw_smoke.py
Mirrors ``sdk/rust/tests/hw_smoke.rs``; restores device state on exit."""

import time

from serial.tools import list_ports

from pochi import Connection, discover_detailed
from pochi.types import (
    EdgeMode,
    PatternMode,
    PatternState,
    PatternStep,
    PinMap,
    PullMode,
)


def main() -> None:
    detailed = discover_detailed()
    assert not detailed.failures, f"probe failures: {detailed.failures}"
    devices = detailed.devices
    assert devices, "no Pochi-DIO found"
    print("discovered:", devices)

    # A Debugprobe (2e8a:000c) on the same host must NOT be detected. Its tty
    # number depends on plug order, so locate it by USB descriptor instead of
    # hard-coding a port name.
    debugprobe_ports = [
        p.device for p in list_ports.comports() if p.vid == 0x2E8A and p.pid == 0x000C
    ]
    print("debugprobe ports:", debugprobe_ports)
    assert all(d.port not in debugprobe_ports for d in devices), (
        "Debugprobe misdetected"
    )

    device = devices[0]
    with Connection.open(device.port) as conn:
        version = conn.version()
        print("version:", version)
        caps = conn.caps()
        print("caps:", caps, "has_sync:", caps.has_sync())
        assert caps.max_dio == 23
        assert caps.ts_resolution_ns != 1000, "old firmware"
        assert conn.info().uid == device.uid

        original_map = conn.map_get()
        print("original map:", original_map)

        conn.map_set(
            PinMap(
                version=1,
                out_base=0,
                out_count=12,
                in_base=12,
                in_count=11,
                pull=PullMode.UP,
                flags=0x01,
            )
        )
        active = conn.map_get()
        assert (active.out_count, active.in_count) == (12, 11)

        conn.write(0x0A5, 0xFFF)
        state = conn.state()
        print("state after write 0x0A5:", state)
        assert (state.outputs & 0xFFF) == 0x0A5
        conn.write(0, 0xFFF)

        accepted = conn.pattern_load(
            [
                PatternStep(out_bits=0x00F, hold_us=1000),
                PatternStep(out_bits=0x000, hold_us=1000),
                PatternStep(out_bits=0x0F0, hold_us=1000),
                PatternStep(out_bits=0x000, hold_us=1000),
            ]
        )
        assert accepted == 4
        conn.pattern_run(PatternMode.ONCE, 1)
        time.sleep(0.05)
        after_once = conn.pattern_status()
        print("pattern status after once:", after_once)
        assert after_once.state is not PatternState.RUNNING
        # repeat=0 is BAD_PARAM on FW — no infinite mode.
        conn.pattern_run(PatternMode.LOOP, 1000)
        time.sleep(0.02)
        assert conn.pattern_status().state is PatternState.RUNNING
        conn.pattern_stop()
        assert conn.pattern_status().state is not PatternState.RUNNING

        conn.ts_arm(0x07FF, EdgeMode.BOTH)
        result = conn.ts_get(256)
        print(f"ts events without stimulus: {len(result.events)}")
        conn.ts_disarm()
        conn.read()  # connection healthy after counted read

        conn.subscribe(True)
        conn.subscribe(False)

        conn.sync_master()
        conn.sync_start()
        c1 = conn.sync_count()
        time.sleep(0.01)
        c2 = conn.sync_count()
        print(f"sync counts: {c1} -> {c2}")
        assert c2 > c1, "sync clock not advancing"
        conn.sync_stop()
        conn.sync_disarm()

        raw = conn.raw("version")
        assert raw.startswith("OK "), raw

        conn.map_set(original_map)
        conn.map_save()
        assert conn.map_get().out_count == original_map.out_count

        print("hw_smoke: all steps passed")


if __name__ == "__main__":
    main()
