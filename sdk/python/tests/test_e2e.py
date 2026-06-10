"""End-to-end tests against a mock firmware (same scenarios as the Rust
PTY E2E in ``sdk/rust/tests/pty_e2e.rs``, over an in-memory port)."""

import time

import pytest

from pochi import Connection, reconcile
from pochi.errors import (
    BadParamError,
    NotArmedError,
    SyncStateError,
    UnsupportedFirmwareError,
)
from pochi.types import (
    EdgeMode,
    InputChangeEvent,
    PatternDoneEvent,
    PatternMode,
    PatternState,
    PatternStep,
    PinMap,
    PullMode,
)

from .fake_port import FakePort, MockFw


def connect_mock(fw: MockFw, pre_push: list[str] | None = None):
    port = FakePort()
    pushes = pre_push or []

    def respond(cmd: str) -> None:
        port.feed(*pushes, *fw.handle(cmd))

    port.on_command = respond
    return Connection.from_port(port), port


def test_full_command_sweep():
    conn, _ = connect_mock(MockFw())

    v = conn.version()
    assert (v.major, v.minor, v.patch, v.protocol_version) == (0, 1, 0, 1)
    caps = conn.caps()
    assert caps.max_dio == 23
    assert caps.ts_resolution_ns == 40
    assert caps.protocol_version == 1
    assert caps.has_sync()
    info = conn.info()
    assert info.uid == "AABBCCDD11223344"
    assert info.device_number == 42
    conn.set_device_number(7)

    assert conn.read() == 0x05
    conn.write(0x0A, 0x0F)
    assert conn.state().outputs == 0x0A

    pin_map = conn.map_get()
    assert pin_map.out_count == 12
    assert pin_map.pull is PullMode.UP
    conn.map_set(
        PinMap(
            version=1,
            out_base=0,
            out_count=8,
            in_base=8,
            in_count=15,
            pull=PullMode.UP,
            flags=1,
        )
    )
    assert conn.map_get().out_count == 8
    conn.map_save()
    conn.map_default()
    assert conn.map_get().in_count == 23

    accepted = conn.pattern_load(
        [PatternStep(out_bits=0x0F, hold_us=100), PatternStep(out_bits=0, hold_us=100)]
    )
    assert accepted == 2
    conn.pattern_run(PatternMode.LOOP, 10)
    assert conn.pattern_status().state is PatternState.RUNNING
    conn.pattern_stop()
    assert conn.pattern_status().state is PatternState.LOADED

    conn.ts_arm(0x07FF, EdgeMode.BOTH)
    result = conn.ts_get(256)
    assert len(result.events) == 2
    assert result.events[0].timestamp_ns == 1_000_280
    assert not result.reconciled
    conn.ts_disarm()

    conn.sync_master()
    conn.sync_start()
    assert conn.sync_count() == 1_000_000
    conn.sync_stop()
    conn.sync_disarm()

    assert conn.raw("version") == "OK v0.1.0 proto=1"
    conn.close()


def test_typed_device_errors():
    conn, _ = connect_mock(MockFw())
    with pytest.raises(NotArmedError):
        conn.ts_get(10)
    with pytest.raises(SyncStateError):
        conn.sync_count()
    with pytest.raises(BadParamError):
        conn.pattern_run(PatternMode.ONCE, 1)
    assert conn.raw("frobnicate") == "ERR UNKNOWN_CMD"


def test_loop_repeat_zero_rejected():
    conn, _ = connect_mock(MockFw())
    conn.pattern_load([PatternStep(out_bits=1, hold_us=1)])
    with pytest.raises(BadParamError):
        conn.pattern_run(PatternMode.LOOP, 0)


def test_push_events_interleaved_with_commands():
    conn, _ = connect_mock(
        MockFw(), ["! INPUT 0x000001 t=100", "! PATTERN_DONE loops=2"]
    )
    events = []
    conn.set_event_callback(events.append)
    conn.subscribe(True)
    assert conn.read() == 0x05

    deadline = time.monotonic() + 1.0
    while len(events) < 4 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert events.count(InputChangeEvent(inputs=1, timestamp_us=100)) == 2
    assert events.count(PatternDoneEvent(loops=2)) == 2


def test_old_firmware_fails_loudly():
    fw = MockFw()
    fw.old_firmware = True
    conn, _ = connect_mock(fw)
    with pytest.raises(UnsupportedFirmwareError):
        conn.caps()
    conn.ts_arm(0x01, EdgeMode.RISING)
    with pytest.raises(UnsupportedFirmwareError):
        conn.ts_get(10)


def test_empty_ts_ring_keeps_connection_healthy():
    fw = MockFw()
    fw.ts_events = []
    conn, _ = connect_mock(fw)
    conn.ts_arm(0x01, EdgeMode.RISING)
    result = conn.ts_get(256)
    assert result.events == []
    assert conn.read() == 0x05


def test_reconcile_pipeline_from_ts_get():
    fw = MockFw()
    # Straddle pair: naive ns values 1000ns apart, reconcile -> zero diff.
    fw.ts_events = ["  0x00000001 c=1001 p=2 s=1", "  0x00000003 c=1000 p=2 s=1"]
    conn, _ = connect_mock(fw)
    conn.ts_arm(0x03, EdgeMode.RISING)
    result = conn.ts_get(256)

    groups = reconcile.group_events(
        [
            reconcile.SourceEvent(
                device="local",
                channel=f"GP{i}",
                inputs=f"0x{ev.inputs:08X}",
                raw_count=ev.raw_count,
                raw_phase=ev.raw_phase,
                sync_active=ev.sync_active,
            )
            for i, ev in enumerate(result.events)
        ]
    )
    assert len(groups) == 1
    assert groups[0].reconciled
    assert groups[0].reconciled_ns[0] == groups[0].reconciled_ns[1]
