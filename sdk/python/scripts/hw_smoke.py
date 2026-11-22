#!/usr/bin/env python3
"""Hardware smoke test — requires a connected Tcapi-DIO device.
Run: .venv/bin/python scripts/hw_smoke.py
Mirrors ``sdk/rust/tests/hw_smoke.rs``; restores device state on exit."""

import time

from serial.tools import list_ports

from tcapi import Connection, discover_detailed
from tcapi.types import (
    VALID_DIO_MASK,
    EdgeMode,
    PatternMode,
    PatternState,
    PatternStep,
    PinMap,
    hold_ticks_from_ns,
)


def main() -> None:
    detailed = discover_detailed()
    assert not detailed.failures, f"probe failures: {detailed.failures}"
    devices = detailed.devices
    assert devices, "no Tcapi-DIO found"
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
        assert caps.dio == 25
        assert caps.ts_res_ns == 40
        assert version.protocol_version == 2
        assert conn.info().uid == device.uid

        original_map = conn.map_get()
        print("original map:", original_map)

        # GP0-GP11 outputs, every other DIO pin an input with pull-up.
        outputs = 0xFFF
        inputs = VALID_DIO_MASK & ~outputs
        conn.map_set(
            PinMap(
                flags=0,
                direction=outputs,
                pull_up=inputs,
                pull_down=0,
                out_default=0,
                out_polarity=0,
                in_polarity=0,
                edge=inputs,
            )
        )
        active = conn.map_get()
        assert active.direction == outputs
        caps = conn.caps()
        assert (caps.out, caps.in_) == (12, 13)

        conn.write(0x0A5, 0xFFF)
        state = conn.state()
        print("state after write 0x0A5:", state)
        assert (state.outputs & 0xFFF) == 0x0A5
        conn.write(0, 0xFFF)

        hold = hold_ticks_from_ns(1_000_000)  # 1 ms
        total = conn.pattern_load(
            [
                PatternStep(out_bits=0x00F, hold_ticks=hold),
                PatternStep(out_bits=0x000, hold_ticks=hold),
                PatternStep(out_bits=0x0F0, hold_ticks=hold),
                PatternStep(out_bits=0x000, hold_ticks=hold),
            ]
        )
        assert total == 4
        conn.pattern_run(PatternMode.ONCE, 1)
        time.sleep(0.05)
        after_once = conn.pattern_status()
        print("pattern status after once:", after_once)
        assert after_once.state is not PatternState.RUNNING
        # repeat=0 is rejected (no infinite mode).
        conn.pattern_run(PatternMode.LOOP, 1000)
        time.sleep(0.02)
        assert conn.pattern_status().state is PatternState.RUNNING
        conn.pattern_stop()
        assert conn.pattern_status().state is not PatternState.RUNNING

        conn.ts_arm(inputs & 0x0FFF_F000, EdgeMode.BOTH)
        result = conn.ts_get(85)
        print(f"ts events without stimulus: {len(result.events)}")
        conn.ts_disarm()
        conn.read()  # connection healthy after counted read

        with conn.subscribe_events():  # `subscribe on` ... `subscribe off`
            pass

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
        assert raw[0].startswith("OK "), raw

        conn.map_set(original_map)
        conn.map_save()
        assert conn.map_get() == original_map

        print("hw_smoke: all steps passed")


if __name__ == "__main__":
    main()
