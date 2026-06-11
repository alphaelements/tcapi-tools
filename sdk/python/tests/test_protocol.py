import pytest

from pochi import protocol
from pochi.errors import (
    BadCommandError,
    BusyError,
    ParseError,
    UnknownDeviceError,
    UnsupportedFirmwareError,
)
from pochi.types import PatternState, PatternStep, PullMode


class TestParseResponse:
    def test_ok_empty(self):
        r = protocol.parse_response("OK\r\n")
        assert (r.kind, r.data) == ("ok", "")

    def test_ok_with_data(self):
        r = protocol.parse_response("OK v0.1.0 proto=1\r\n")
        assert (r.kind, r.data) == ("ok", "v0.1.0 proto=1")

    def test_err(self):
        r = protocol.parse_response("ERR BAD_CMD")
        assert (r.kind, r.data) == ("err", "BAD_CMD")

    def test_push(self):
        r = protocol.parse_response("! INPUT 0x05 t=99")
        assert (r.kind, r.data) == ("push", "INPUT 0x05 t=99")

    @pytest.mark.parametrize("line", ["garbage", "OKAY nope", ""])
    def test_garbage_rejected(self, line):
        with pytest.raises(ParseError):
            protocol.parse_response(line)

    def test_ok_data_maps_err_codes(self):
        with pytest.raises(BusyError):
            protocol.Response("err", "BUSY").ok_data()
        with pytest.raises(UnknownDeviceError):
            protocol.Response("err", "WHAT").ok_data()
        with pytest.raises(ParseError):
            protocol.Response("push", "INPUT").ok_data()
        with pytest.raises(BadCommandError):
            protocol.Response("err", "UNKNOWN_CMD").ok_data()


class TestCountField:
    @pytest.mark.parametrize(
        ("data", "expected"),
        [("count=2", 2), ("count=0", 0), ("count=1000000", 1000000)],
    )
    def test_valid(self, data, expected):
        assert protocol.parse_count_field(data) == expected

    @pytest.mark.parametrize("data", ["n=2", "count=abc", "count=-1"])
    def test_invalid(self, data):
        with pytest.raises(ParseError):
            protocol.parse_count_field(data)


class TestCountOverflowField:
    @pytest.mark.parametrize(
        ("data", "expected"),
        [
            ("count=3 overflow=0", (3, False)),
            ("count=85 overflow=1", (85, True)),
            ("overflow=1 count=4", (4, True)),
        ],
    )
    def test_new_fw_form(self, data, expected):
        assert protocol.parse_count_overflow_field(data) == expected

    @pytest.mark.parametrize(
        ("data", "expected"),
        [("count=3", (3, False)), ("count=0", (0, False))],
    )
    def test_old_fw_missing_overflow(self, data, expected):
        assert protocol.parse_count_overflow_field(data) == expected

    @pytest.mark.parametrize(
        "data",
        ["count=1 overflow=2", "count=1 overflow=yes", "overflow=0"],
    )
    def test_invalid(self, data):
        with pytest.raises(ParseError):
            protocol.parse_count_overflow_field(data)


class TestVersion:
    def test_basic(self):
        v = protocol.parse_version("v0.1.0 proto=1")
        assert (v.major, v.minor, v.patch, v.protocol_version) == (0, 1, 0, 1)

    def test_multi_digit(self):
        v = protocol.parse_version("v12.34.56 proto=2")
        assert (v.major, v.minor, v.patch) == (12, 34, 56)

    @pytest.mark.parametrize(
        "data", ["proto=1", "v0.1.0", "v0.1 proto=1", "vX.Y.Z proto=1", ""]
    )
    def test_malformed(self, data):
        with pytest.raises(ParseError):
            protocol.parse_version(data)


class TestCaps:
    GOOD = "dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000001"

    def test_basic(self):
        c = protocol.parse_caps(self.GOOD)
        assert c.max_dio == 23
        assert c.out_count == 12
        assert c.in_count == 11
        assert c.ts_resolution_ns == 40
        assert c.max_pattern_steps == 256
        assert c.ts_ring_events == 256
        assert c.features == 1
        assert c.has_sync()

    def test_old_firmware_rejected(self):
        with pytest.raises(UnsupportedFirmwareError):
            protocol.parse_caps(
                "dio=23 out=12 in=11 ts_res=1000ns pattern=256 ring=256 feat=0x1"
            )

    @pytest.mark.parametrize(
        "data",
        [
            "dio=23 out=12 in=11",
            "dio=banana out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x1",
        ],
    )
    def test_malformed(self, data):
        with pytest.raises(ParseError):
            protocol.parse_caps(data)


class TestInfo:
    def test_basic(self):
        assert protocol.parse_info("uid=AABBCCDD11223344 devnum=42") == (
            "AABBCCDD11223344",
            42,
        )

    def test_unassigned(self):
        assert protocol.parse_info("uid=AABB devnum=255") == ("AABB", None)

    @pytest.mark.parametrize("data", ["devnum=1", "uid=AABB devnum=zzz"])
    def test_malformed(self, data):
        with pytest.raises(ParseError):
            protocol.parse_info(data)


class TestMap:
    def test_basic(self):
        m = protocol.parse_map("v=1 out=0:12 in=12:11 pull=up flags=0x01")
        assert (m.out_base, m.out_count, m.in_base, m.in_count) == (0, 12, 12, 11)
        assert m.pull is PullMode.UP
        assert m.flags == 1

    @pytest.mark.parametrize(
        "data",
        [
            "v=1 out=0:0 in=0:23 pull=sideways flags=0x01",
            "v=1 out=0:12",
            "v=1 out=012 in=0:23 pull=up flags=0x01",
        ],
    )
    def test_malformed(self, data):
        with pytest.raises(ParseError):
            protocol.parse_map(data)

    def test_round_trip_hex(self):
        m = protocol.parse_map("v=1 out=0:12 in=12:11 pull=up flags=0x01")
        hex_str = protocol.map_to_hex(m)
        assert len(hex_str) == 48
        data = bytes.fromhex(hex_str)
        assert list(data[:7]) == [1, 0, 12, 12, 11, 1, 1]
        assert all(b == 0 for b in data[7:])


class TestReadState:
    def test_read(self):
        assert protocol.parse_read("0x000005") == 5
        assert protocol.parse_read(" 0x0 ") == 0

    @pytest.mark.parametrize("data", ["five", ""])
    def test_read_malformed(self, data):
        with pytest.raises(ParseError):
            protocol.parse_read(data)

    def test_state(self):
        s = protocol.parse_state("in=0x000005 out=0x00000A flags=0x00")
        assert (s.inputs, s.outputs, s.flags) == (5, 10, 0)

    def test_state_missing_field(self):
        with pytest.raises(ParseError):
            protocol.parse_state("in=0x05 out=0x0A")


class TestPattern:
    def test_hex_count_prefix(self):
        hex_str = protocol.pattern_to_hex(
            [
                PatternStep(out_bits=0x0F, hold_us=100),
                PatternStep(out_bits=0, hold_us=200),
            ]
        )
        data = bytes.fromhex(hex_str)
        assert len(data) == 2 + 2 * 8
        assert int.from_bytes(data[0:2], "little") == 2
        assert int.from_bytes(data[2:6], "little") == 0x0F
        assert int.from_bytes(data[6:10], "little") == 100

    def test_empty_rejected(self):
        with pytest.raises(ParseError):
            protocol.pattern_to_hex([])

    def test_accepted(self):
        assert protocol.parse_accepted("accepted=4") == 4
        with pytest.raises(ParseError):
            protocol.parse_accepted("ok")

    def test_run_commands(self):
        from pochi.types import PatternMode

        assert protocol.pattern_run_command(PatternMode.ONCE, 1) == "pattern run once 1"
        assert (
            protocol.pattern_run_command(PatternMode.LOOP, 10) == "pattern run loop 10"
        )

    @pytest.mark.parametrize(
        ("state", "expected"),
        [
            ("idle", PatternState.IDLE),
            ("loaded", PatternState.LOADED),
            ("running", PatternState.RUNNING),
            ("done", PatternState.DONE),
        ],
    )
    def test_status_states(self, state, expected):
        s = protocol.parse_pattern_status(f"state={state} step=0 loops=0")
        assert s.state is expected

    @pytest.mark.parametrize("data", ["state=paused step=0 loops=0", "state=idle"])
    def test_status_malformed(self, data):
        with pytest.raises(ParseError):
            protocol.parse_pattern_status(data)


class TestTimestamp:
    def test_arm_commands(self):
        from pochi.types import EdgeMode

        assert protocol.ts_arm_command(0x07FF, EdgeMode.RISING) == "ts arm 0x7ff rising"
        assert protocol.ts_arm_command(0xFF, EdgeMode.BOTH) == "ts arm 0xff both"

    def test_event_basic(self):
        ev = protocol.parse_ts_event_line("  0x00000005 c=1000 p=7 s=1")
        assert ev.inputs == 5
        assert ev.raw_count == 1000
        assert ev.raw_phase == 7
        assert ev.sync_active
        assert ev.timestamp_ns == 1_000_280

    def test_event_free_running(self):
        ev = protocol.parse_ts_event_line("0x00000001 c=500 p=0 s=0")
        assert not ev.sync_active
        assert ev.timestamp_ns == 500_000

    def test_old_format_unsupported_firmware(self):
        with pytest.raises(UnsupportedFirmwareError):
            protocol.parse_ts_event_line("0x00000005 t=1234567890")

    @pytest.mark.parametrize(
        "line",
        ["0x05 c=1000 p=7", "c=1000 p=7 s=1", "", "0x05 c=1000 p=7 s=2"],
    )
    def test_event_malformed(self, line):
        with pytest.raises(ParseError):
            protocol.parse_ts_event_line(line)


class TestSync:
    def test_count(self):
        assert protocol.parse_sync_count("count=1000000") == 1_000_000
        with pytest.raises(ParseError):
            protocol.parse_sync_count("1000000")


class TestPushEvents:
    def test_input(self):
        from pochi.types import InputChangeEvent

        ev = protocol.parse_push_event("INPUT 0x000005 t=1234567890")
        assert ev == InputChangeEvent(inputs=5, timestamp_us=1234567890)

    def test_pattern_done(self):
        from pochi.types import PatternDoneEvent

        assert protocol.parse_push_event("PATTERN_DONE loops=10") == PatternDoneEvent(
            loops=10
        )

    def test_sync_done(self):
        from pochi.types import SyncDoneEvent

        ev = protocol.parse_push_event("SYNC_DONE status=ready devnum=1 ts=12345")
        assert ev == SyncDoneEvent(status="ready", devnum=1, timestamp=12345)

    def test_unknown_preserved(self):
        from pochi.types import UnknownEvent

        assert protocol.parse_push_event("FUTURE_EVENT data=1") == UnknownEvent(
            raw="FUTURE_EVENT data=1"
        )

    @pytest.mark.parametrize(
        "payload", ["INPUT t=99", "INPUT 0x05", "PATTERN_DONE loops=abc"]
    )
    def test_malformed(self, payload):
        with pytest.raises(ParseError):
            protocol.parse_push_event(payload)
