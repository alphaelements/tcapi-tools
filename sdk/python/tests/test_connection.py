"""Typed ``Connection`` API against golden-derived fakes (replaces the
hand-written MockFw, R-C4). Each test replays a golden case: the requests the
SDK writes must equal the transcript's, and every device line is the
transcript's. Hand-written lines appear only in tests marked NEGATIVE."""

import queue

import pytest

import pochi
from pochi import Connection
from pochi.connection import EventSubscription
from pochi.errors import (
    BadParamError,
    BusyError,
    DisconnectedError,
    FlashError,
    InvalidArgumentError,
    NotArmedError,
    NotRunningError,
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
    PatternTimeoutEvent,
    PinMap,
    SyncRole,
    SyncState,
)

from .fake_port import FakePort
from .golden import ReplayPort, find_case, first_response, parse_file


def replay(file: str, title_part: str, *, exact: bool = False):
    """Connection over a ReplayPort of the golden case; returns
    ``(conn, port)``. Call :func:`finish` at the end."""
    port = ReplayPort(find_case(file, title_part, exact=exact))
    return Connection.from_port(port), port


def finish(conn: Connection, port: ReplayPort) -> None:
    assert port.mismatches == []
    assert port.exhausted, f"{len(port._steps)} golden steps were not used"
    conn.close()


MAP_S1 = PinMap(0, 0x0F, 0xF0, 0x0C7FFF00, 0x05, 0x08, 0x100, 0x0C7FFFF0)
MAP_GP0_1 = PinMap(0, 0x3, 0, 0x0C7FFFFC, 0, 0, 0, 0x0C7FFFFC)
MAP_IO = PinMap(0, 0xF, 0, 0x0C7FFFF0, 0x5, 0, 0, 0x0C7FFFF0)


# --- open / handshake (R-U2) ---


class TestHandshake:
    def test_from_port_sends_version_and_records_it(self):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        assert port.written == ["version"]
        assert conn.protocol_version == 2
        conn.close()

    def test_version_command(self):
        conn, port = replay("version-info", "version", exact=True)
        v = conn.version()
        assert (v.major, v.minor, v.patch, v.protocol_version) == (0, 1, 3, 2)
        finish(conn, port)

    @pytest.mark.parametrize(
        "response",
        [
            "OK v0.1.0 proto=1",  # a v1 device
            "OK fw=0.2.0 proto=3",
            "OK fw=0.1.3 proto=1",
            "OK garbage",
        ],
    )
    def test_other_protocol_is_refused_and_port_closed(self, response):
        # NEGATIVE: a device that is not proto=2
        port = FakePort()
        port.on_command = lambda _: port.feed(response)
        with pytest.raises(UnsupportedFirmwareError, match="unsupported protocol"):
            Connection.from_port(port)
        assert port.closed

    def test_handshake_error_response_closes_the_port(self):
        # NEGATIVE
        port = FakePort()
        port.on_command = lambda _: port.feed("ERR UNKNOWN_CMD")
        with pytest.raises(pochi.UnknownCmdError):
            Connection.from_port(port)
        assert port.closed


# --- device information ---


class TestDeviceInfo:
    def test_caps_follow_the_direction_mask(self):
        conn, port = replay("version-info", "caps follows the direction mask")
        conn.map_set(MAP_GP0_1)
        caps = conn.caps()
        assert (caps.dio, caps.out, caps.in_) == (25, 2, 23)
        assert (caps.ts_res_ns, caps.tick_ns, caps.pattern_max, caps.ring) == (
            40,
            200,
            256,
            256,
        )
        assert caps.has_sync() and caps.has_reset()
        finish(conn, port)

    def test_info_and_devnum(self):
        conn, port = replay("version-info", "devnum: assign, read back, clear")
        conn.set_device_number(7)
        assert conn.info().device_number == 7
        conn.set_device_number(255)
        info = conn.info()
        assert info.device_number is None
        assert info.uid == "0000000000000000"
        assert info.version == "0.1.3"  # fw= of the handshake
        finish(conn, port)

    def test_ping_returns_the_echo(self):
        conn, port = replay("version-info", "ping echoes the u32")
        assert conn.ping(0) == 0
        assert conn.ping(12345) == 12345
        finish(conn, port)

    def test_ping_mismatch_is_a_parse_error(self):
        # NEGATIVE: device echoes another value
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        port.on_command = lambda _: port.feed("OK pong=6")
        with pytest.raises(pochi.ParseError):
            conn.ping(5)

    @pytest.mark.parametrize("n", [-1, 256])
    def test_set_device_number_range_checked_locally(self, n):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        with pytest.raises(InvalidArgumentError):
            conn.set_device_number(n)
        assert port.written == ["version"]


# --- pin map ---


class TestPinMap:
    def test_map_set_then_get_round_trips(self):
        conn, port = replay("map", "map set: full map, then get echoes it")
        conn.map_set(MAP_S1)
        assert conn.map_get() == MAP_S1
        finish(conn, port)

    def test_map_get_default(self):
        conn, port = replay("map", "map get: default map")
        assert conn.map_get() == PinMap.default()
        finish(conn, port)

    def test_invalid_map_is_refused_before_sending(self):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        with pytest.raises(InvalidArgumentError, match="flags"):
            conn.map_set(PinMap(1, 0, 0, 0, 0, 0, 0, 0))
        assert port.written == ["version"]

    def test_map_save_and_default(self):
        conn, port = replay("map", "map default and map save on the default map")
        conn.map_default()
        conn.map_save()
        assert conn.map_get() == PinMap.default()
        finish(conn, port)

    def test_map_save_flash_failure_then_reset_restores_default(self):
        conn, port = replay("map", "map save: flash write failure")
        conn.map_set(MAP_S1)
        with pytest.raises(FlashError):
            conn.map_save()
        conn.system_reset()
        assert conn.map_get() == PinMap.default()
        finish(conn, port)

    def test_map_set_busy_while_running(self):
        conn, port = replay(
            "map", "map set and map default are refused while a pattern is running"
        )
        conn.map_set(MAP_GP0_1)
        conn.pattern_add([PatternStep(1, 100), PatternStep(0, 100)])
        conn.pattern_run(PatternMode.LOOP, 1000)
        with pytest.raises(BusyError):
            conn.map_set(MAP_S1)
        with pytest.raises(BusyError):
            conn.map_default()
        assert conn.map_get() == MAP_GP0_1  # map get is still served
        conn.pattern_stop()
        conn.map_set(MAP_S1)
        assert conn.map_get() == MAP_S1
        finish(conn, port)

    def test_device_bad_map_is_typed(self):
        # The SDK validates first, so a BAD_MAP can only reach the host through
        # raw(); the response is returned, not raised.
        conn, port = replay("map", "map set rejected: flags has a reserved bit set")
        port_lines = conn.raw(
            "map set flags=0x01 dir=0x00000000 pu=0x00000000 pd=0x00000000 "
            "def=0x00000000 opol=0x00000000 ipol=0x00000000 edge=0x00000000"
        )
        assert port_lines == ["ERR BAD_MAP"]
        assert conn.map_get() == PinMap.default()  # a failed map set changes nothing
        finish(conn, port)


# --- digital I/O ---


class TestIo:
    def test_write_masked_then_state(self):
        conn, port = replay("io", "write: only the masked pins change")
        conn.map_set(MAP_IO)
        conn.write(0x2, 0x3)
        s = conn.state()
        assert (s.inputs, s.outputs) == (0, 0x6)
        finish(conn, port)

    def test_read_follows_the_driven_inputs(self):
        conn, port = replay("io", "read: default map, undriven inputs read 0")
        assert conn.read() == 0
        finish(conn, port)

    def test_state_default_map(self):
        conn, port = replay("io", "state: default map")
        s = conn.state()
        assert (s.inputs, s.outputs) == (0, 0)
        finish(conn, port)

    def test_write_with_non_dio_bits_is_refused_locally(self):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        with pytest.raises(InvalidArgumentError):
            conn.write(0x00800000, 0x1)
        with pytest.raises(InvalidArgumentError):
            conn.write(0x1, 0x10000000)
        assert port.written == ["version"]

    def test_write_to_a_non_output_surfaces_typed(self):
        conn, port = replay("io", "write: mask covers a pin that is not an output")
        conn.map_set(MAP_IO)
        with pytest.raises(BadParamError):
            conn.write(0x10, 0x10)
        with pytest.raises(BadParamError):
            conn.write(0xF, 0x1F)
        assert conn.state().outputs == 0x5
        finish(conn, port)


# --- pattern ---


class TestPattern:
    def test_add_accumulates_totals(self):
        conn, port = replay("pattern", "pattern add: totals accumulate over calls")
        conn.map_set(MAP_GP0_1)
        assert conn.pattern_add([PatternStep(1, 5), PatternStep(0, 10)]) == 2
        assert conn.pattern_add([PatternStep(2, 1)]) == 3
        assert (
            conn.pattern_add([PatternStep(3, 7), PatternStep(0, 7), PatternStep(1, 7)])
            == 6
        )
        s = conn.pattern_status()
        assert (s.state, s.step, s.loops, s.total) == (PatternState.LOADED, 0, 0, 6)
        finish(conn, port)

    def test_add_single_all_low_step(self):
        conn, port = replay(
            "pattern", "pattern add: out_bits 0 is a valid all-low step"
        )
        conn.map_set(MAP_GP0_1)
        assert conn.pattern_add([PatternStep(0, 1)]) == 1
        finish(conn, port)

    def test_status_idle(self):
        conn, port = replay("pattern", "pattern status: nothing loaded")
        s = conn.pattern_status()
        assert s.state is PatternState.IDLE and s.total == 0
        finish(conn, port)

    def test_stop_when_not_running_is_typed(self):
        conn, port = replay("pattern", "pattern stop: not running is refused")
        conn.map_set(MAP_GP0_1)
        with pytest.raises(NotRunningError):
            conn.pattern_stop()
        conn.pattern_add([PatternStep(1, 5), PatternStep(0, 10)])
        with pytest.raises(NotRunningError):
            conn.pattern_stop()
        conn.pattern_run(PatternMode.ONCE, 1)
        with pytest.raises(NotRunningError):
            conn.pattern_stop()
        s = conn.pattern_status()
        assert (s.state, s.loops) == (PatternState.DONE, 1)
        finish(conn, port)

    def test_reset_clears_the_buffer(self):
        conn, port = replay("pattern", "pattern reset: clears loaded steps")
        conn.map_set(MAP_GP0_1)
        conn.pattern_add([PatternStep(1, 5), PatternStep(0, 10)])
        conn.pattern_reset()
        assert conn.pattern_status().state is PatternState.IDLE
        with pytest.raises(BadParamError):
            conn.pattern_run(PatternMode.ONCE, 1)
        finish(conn, port)

    def test_run_loop_and_status_progress(self):
        conn, port = replay(
            "pattern", "pattern run loop 3: loops counts completed passes"
        )
        conn.map_set(MAP_GP0_1)
        conn.pattern_add([PatternStep(1, 5), PatternStep(0, 10)])
        conn.pattern_run(PatternMode.LOOP, 3)
        seen = [conn.pattern_status() for _ in range(4)]
        assert [(s.state, s.step, s.loops, s.total) for s in seen] == [
            (PatternState.RUNNING, 0, 1, 2),
            (PatternState.RUNNING, 1, 1, 2),
            (PatternState.RUNNING, 1, 2, 2),
            (PatternState.DONE, 0, 3, 2),
        ]
        finish(conn, port)

    def test_run_loop_repeat_range_checked_locally(self):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        for repeat in (0, 65536):
            with pytest.raises(InvalidArgumentError):
                conn.pattern_run(PatternMode.LOOP, repeat)
        assert port.written == ["version"]

    def test_load_is_reset_then_add_in_line_sized_chunks(self):
        # R-PT3 / section 3: reset, then as many `pattern add` lines as the
        # 256-byte line limit needs. The 256-step transcript is the oracle.
        case = find_case("boundary", "256 pattern steps are accepted")
        reqs = case.requests[:7]
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        responses = iter([r.response for r in reqs])
        port.on_command = lambda line: (
            port.feed("OK") if line == "pattern reset" else port.feed(*next(responses))
        )
        assert conn.pattern_load([PatternStep(0, 1)] * 256) == 256
        assert port.written[1] == "pattern reset"
        assert port.written[2:] == [r.text for r in reqs]

    def test_load_validates_every_step_before_resetting(self):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        with pytest.raises(InvalidArgumentError):
            conn.pattern_load([PatternStep(0, 1), PatternStep(0, 0)])
        assert port.written == ["version"]  # not even the reset was sent


# --- timestamp ---


class TestTimestamp:
    def test_arm_status_get_empty_disarm(self):
        conn, port = replay(
            "timestamp",
            "ts arm then status, get with no events returns count=0, disarm",
        )
        conn.ts_arm(0x1, EdgeMode.RISING)
        st = conn.ts_status()
        assert (st.armed, st.pending, st.overflow) == (True, 0, False)
        result = conn.ts_get(5)
        assert result.events == [] and result.overflow is False
        conn.ts_disarm()
        assert conn.ts_status().armed is False
        finish(conn, port)

    def test_ts_get_returns_events(self):
        conn, port = replay(
            "timestamp", "ts rising: only logical rising edges are recorded"
        )
        conn.ts_arm(0x1, EdgeMode.RISING)
        assert conn.ts_status().pending == 2
        result = conn.ts_get(10)
        assert [
            (e.inputs, e.raw_count, e.raw_phase, e.sync_active) for e in result.events
        ] == [
            (1, 1000, 0, False),
            (1, 1500, 0, False),
        ]
        assert result.overflow is False
        assert result.events[0].ns(40) == 1_000_000
        assert conn.ts_status().pending == 0
        finish(conn, port)

    def test_overflow_is_reported_once_and_oldest_first(self):
        conn, port = replay(
            "timestamp", "ts ring overflow: the oldest events are overwritten"
        )
        conn.ts_arm(0x1, EdgeMode.BOTH)
        st = conn.ts_status()
        assert (st.armed, st.pending, st.overflow) == (True, 256, True)
        first = conn.ts_get(5)
        assert first.overflow is True
        assert [e.raw_count for e in first.events] == [20, 30, 40, 50, 60]
        st = conn.ts_status()
        assert (st.pending, st.overflow) == (251, False)
        second = conn.ts_get(2)
        assert second.overflow is False
        assert [e.raw_count for e in second.events] == [70, 80]
        finish(conn, port)

    def test_events_under_sync_use_the_phase(self):
        conn, port = replay("timestamp", "ts under sync")
        conn.sync_master()
        conn.sync_start()
        conn.ts_arm(0x1, EdgeMode.BOTH)
        conn.sync_stop()
        result = conn.ts_get(10)
        assert [
            (e.inputs, e.raw_count, e.raw_phase, e.sync_active) for e in result.events
        ] == [
            (1, 2, 12, True),
            (0, 3, 24, True),
            (1, 4, 0, True),
            (0, 107, 0, False),
        ]
        assert [e.ns(40) for e in result.events] == [2480, 3960, 4000, 107000]
        finish(conn, port)

    def test_ts_get_not_armed(self):
        conn, port = replay("timestamp", "ts get: not armed")
        with pytest.raises(NotArmedError):
            conn.ts_get(1)
        conn.ts_arm(0x1, EdgeMode.BOTH)
        conn.ts_disarm()
        with pytest.raises(NotArmedError):
            conn.ts_get(1)
        finish(conn, port)

    def test_ts_get_range_is_checked_locally(self):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        for bad in (0, 86, 65535, -1):
            with pytest.raises(InvalidArgumentError):
                conn.ts_get(bad)
        assert port.written == ["version"]

    def test_ts_arm_mask_outside_dio_is_refused_locally(self):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        with pytest.raises(InvalidArgumentError):
            conn.ts_arm(0x10000000, EdgeMode.BOTH)
        assert port.written == ["version"]


# --- sync ---


class TestSync:
    def test_master_cycle_and_count(self):
        conn, port = replay("sync", "sync master -> start -> count -> stop")
        conn.sync_master()
        conn.sync_start()
        assert [conn.sync_count() for _ in range(4)] == [0, 1000, 1000, 1001]
        conn.sync_stop()
        with pytest.raises(SyncStateError):
            conn.sync_count()
        finish(conn, port)

    def test_slave_arm_disarm(self):
        conn, port = replay(
            "sync", "sync arm: slave-armed state, every other transition is refused"
        )
        conn.sync_arm()
        with pytest.raises(SyncStateError):
            conn.sync_arm()
        with pytest.raises(SyncStateError):
            conn.sync_master()
        with pytest.raises(SyncStateError):
            conn.sync_start()
        with pytest.raises(SyncStateError):
            conn.sync_stop()
        with pytest.raises(SyncStateError):
            conn.sync_count()
        finish(conn, port)

    def test_role_and_state_enums(self):
        assert SyncRole.MASTER.value == "master" and SyncRole.SLAVE.value == "slave"
        assert [s.value for s in SyncState] == [
            "idle",
            "armed",
            "master_armed",
            "clocking",
        ]


# --- reset ---


class TestReset:
    def test_reset_then_the_device_answers_again(self):
        conn, port = replay(
            "reset", "reset: acknowledges, the device then reboots and answers again"
        )
        conn.system_reset()
        assert conn.version().protocol_version == 2
        finish(conn, port)

    def test_bootsel(self):
        conn, port = replay(
            "reset", "bootsel: acknowledges, then the device re-enumerates"
        )
        conn.bootsel_reset()
        finish(conn, port)


# --- raw ---


class TestRaw:
    def test_raw_returns_all_lines_of_a_counted_response(self):
        conn, port = replay("reset", "help: counted response")
        lines = conn.raw("help")
        assert lines[0] == "OK count=16"
        assert len(lines) == 17
        finish(conn, port)

    def test_raw_returns_error_lines(self):
        conn, port = replay("errors", "an error leaves the device usable")
        assert conn.raw("nonsense") == ["ERR UNKNOWN_CMD"]
        assert conn.raw("ping 1") == ["OK pong=1"]
        assert conn.raw("ts get 1") == ["ERR NOT_ARMED"]
        assert conn.raw("version") == ["OK fw=0.1.3 proto=2"]
        finish(conn, port)

    @pytest.mark.parametrize(
        "cmd", ["subscribe on", "subscribe off", "SUBSCRIBE on", "  Subscribe"]
    )
    def test_raw_rejects_subscribe_locally(self, cmd):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        with pytest.raises(InvalidArgumentError, match="subscribe"):
            conn.raw(cmd)
        assert port.written == ["version"]

    @pytest.mark.parametrize(
        "cmd", ["read\nsubscribe on", "read\r\nsubscribe on", "read\r\n", "\nping 1"]
    )
    def test_raw_rejects_cr_lf_locally(self, cmd):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        with pytest.raises(InvalidArgumentError, match="CR/LF"):
            conn.raw(cmd)
        assert port.written == ["version"]

    def test_raw_rejects_lines_over_256_bytes_locally(self):
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        with pytest.raises(InvalidArgumentError, match="256"):
            conn.raw("ping " + "1" * 252)  # 257 bytes
        assert port.written == ["version"]

    def test_raw_accepts_a_256_byte_line(self):
        conn, port = replay("boundary", "line length 256 bytes (the limit")
        line = port._steps[0].text
        assert len(line) == 256
        assert conn.raw(line) == ["OK total=40"]
        assert conn.raw("pattern status") == ["OK state=loaded step=0 loops=0 total=40"]
        finish(conn, port)


# --- event subscription ownership (R-H4) ---


def event_line(kind: str) -> str:
    for case in parse_file("events"):
        for ev in case.events:
            if ev.wire.startswith(f"! {kind}"):
                return ev.wire
    raise AssertionError(kind)


SUBSCRIBE_ON = first_response("timestamp", "subscribe on")
SUBSCRIBE_OFF = first_response("timestamp", "subscribe off")


class TestSubscriptions:
    def make(self):
        port = ReplayPort(None)
        conn = Connection.from_port(port)

        def respond(line):
            if line == "subscribe on":
                port.feed(*SUBSCRIBE_ON)
            elif line == "subscribe off":
                port.feed(*SUBSCRIBE_OFF)
            else:
                raise AssertionError(f"unexpected command {line!r}")

        port.on_command = respond
        return conn, port

    def test_first_subscriber_sends_on_last_sends_off(self):
        conn, port = self.make()
        a = conn.subscribe_events()
        assert port.written == ["version", "subscribe on"]
        b = conn.subscribe_events()
        assert port.written == ["version", "subscribe on"]  # refcount 1 -> 2: nothing
        a.close()
        assert port.written == ["version", "subscribe on"]  # 2 -> 1: nothing
        b.close()
        assert port.written == ["version", "subscribe on", "subscribe off"]  # 1 -> 0

    def test_close_is_idempotent_and_does_not_double_off(self):
        conn, port = self.make()
        a = conn.subscribe_events()
        a.close()
        a.close()
        assert port.written.count("subscribe off") == 1

    def test_resubscribe_after_zero_sends_on_again(self):
        conn, port = self.make()
        conn.subscribe_events().close()
        conn.subscribe_events()
        assert port.written == [
            "version",
            "subscribe on",
            "subscribe off",
            "subscribe on",
        ]

    def test_one_subscription_fanned_out_to_all_subscribers(self):
        conn, port = self.make()
        a = conn.subscribe_events()
        b = conn.subscribe_events()
        port.feed(event_line("INPUT"), event_line("PATTERN_DONE"))
        for sub in (a, b):
            first = sub.get(timeout=1)
            second = sub.get(timeout=1)
            assert isinstance(first, InputChangeEvent)
            assert isinstance(second, PatternDoneEvent)
        assert port.written.count("subscribe on") == 1

    def test_closed_subscriber_stops_receiving(self):
        conn, port = self.make()
        a = conn.subscribe_events()
        b = conn.subscribe_events()
        a.close()
        port.feed(event_line("INPUT"))
        assert isinstance(b.get(timeout=1), InputChangeEvent)
        with pytest.raises(queue.Empty):
            a.get(timeout=0.1)

    def test_context_manager_closes(self):
        conn, port = self.make()
        with conn.subscribe_events() as sub:
            assert isinstance(sub, EventSubscription)
        assert port.written[-1] == "subscribe off"

    def test_timeout_event_is_delivered(self):
        conn, port = self.make()
        sub = conn.subscribe_events()
        port.feed(event_line("PATTERN_TIMEOUT"))
        assert isinstance(sub.get(timeout=1), PatternTimeoutEvent)

    def test_failed_subscribe_on_registers_nobody(self):
        # No input pins configured: the golden answer is ERR NO_RESOURCE.
        port = ReplayPort(None)
        conn = Connection.from_port(port)
        err = first_response("timestamp", "subscribe on")  # reused below only for shape
        assert err == ["OK"]
        port.on_command = lambda line: port.feed("ERR NO_RESOURCE")
        with pytest.raises(pochi.NoResourceError):
            conn.subscribe_events()
        # A later attempt starts from zero again.
        port.on_command = lambda line: port.feed(*SUBSCRIBE_ON)
        conn.subscribe_events()
        assert port.written.count("subscribe on") == 2

    def test_no_public_subscribe_bool(self):
        assert not hasattr(Connection, "subscribe")
        assert not hasattr(Connection, "set_event_callback")

    def test_golden_events_case_through_the_connection(self):
        case = find_case("events", "events are not sent before subscribe on")
        port = ReplayPort(case)
        conn = Connection.from_port(port)
        sub = conn.subscribe_events()  # `subscribe on` of the case
        event = sub.get(timeout=1)
        assert event == InputChangeEvent(inputs=0, t_us=2)
        sub.close()  # `subscribe off` of the case
        assert port.mismatches == [] and port.exhausted

    def test_close_connection_detaches_subscribers_without_commands(self):
        conn, port = self.make()
        sub = conn.subscribe_events()
        conn.close()
        assert port.written == ["version", "subscribe on"]
        sub.close()  # no-op on a dead connection, must not raise
        assert port.written == ["version", "subscribe on"]


def test_unknown_event_is_logged_and_never_delivered(caplog):
    port = ReplayPort(None)
    conn = Connection.from_port(port)
    port.on_command = lambda line: port.feed("OK")
    sub = conn.subscribe_events()
    with caplog.at_level("ERROR", logger="pochi"):
        port.feed("! FROBNICATE x=1", event_line("INPUT"))
        got = sub.get(timeout=1)
    assert isinstance(got, InputChangeEvent)
    assert any("FROBNICATE" in r.message for r in caplog.records)
    with pytest.raises(queue.Empty):
        sub.get(timeout=0.1)


def test_disconnect_surfaces_as_disconnected_error():
    port = ReplayPort(None)
    conn = Connection.from_port(port)
    port.closed = True
    with pytest.raises(DisconnectedError):
        conn.read()
