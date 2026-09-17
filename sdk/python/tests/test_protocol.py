import pytest

from pochi import protocol
from pochi.errors import (
    BadCommandError,
    BusyError,
    ParseError,
    UnknownDeviceError,
    UnsupportedFirmwareError,
)
from pochi.types import PatternState, PatternStep, PinMapV2, PullMode


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
        from pochi.types import FEAT_SYNC

        c = protocol.parse_caps(self.GOOD)
        assert c.max_dio == 23
        assert c.out_count == 12
        assert c.in_count == 11
        assert c.ts_resolution_ns == 40
        assert c.max_pattern_steps == 256
        assert c.ts_ring_events == 256
        assert (c.features & FEAT_SYNC) != 0
        assert c.has_sync()
        assert not c.has_reset()

    def test_has_reset(self):
        from pochi.types import FEAT_RESET, FEAT_SYNC

        assert FEAT_SYNC == 0x1
        assert FEAT_RESET == 0x2

        both = protocol.parse_caps(
            "dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000003"
        )
        assert both.has_sync()
        assert both.has_reset()

        none = protocol.parse_caps(
            "dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000000"
        )
        assert not none.has_sync()
        assert not none.has_reset()

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


class TestMapV2:
    HEADER = "v=2 out=4 in=21 flags=0x01"

    def _channel_lines(self, out_channels: set[int]) -> list[str]:
        return [
            f"  ch{ch}: {'OUT' if ch in out_channels else 'IN'}" for ch in range(25)
        ]

    def test_header_only_no_channel_lines(self):
        m = protocol.parse_map(self.HEADER)
        assert isinstance(m, PinMapV2)
        assert m.version == 2
        assert m.out_count == 4
        assert m.in_count == 21
        assert m.flags == 1
        assert m.direction_mask == 0
        assert m.channels == []

    def test_with_channel_lines_reconstructs_direction_mask(self):
        lines = self._channel_lines({0, 1, 2, 3})
        m = protocol.parse_map(self.HEADER, lines)
        assert m.direction_mask == 0x0F
        assert m.channels[0] == "OUT"
        assert m.channels[24] == "IN"

    def test_ch23_ch24_map_to_gp26_gp27(self):
        lines = self._channel_lines({23, 24})
        m = protocol.parse_map("v=2 out=2 in=23 flags=0x00", lines)
        assert m.direction_mask == (1 << 26) | (1 << 27)

    def test_all_inputs(self):
        lines = self._channel_lines(set())
        m = protocol.parse_map("v=2 out=0 in=25 flags=0x00", lines)
        assert m.direction_mask == 0

    def test_all_outputs(self):
        lines = self._channel_lines(set(range(25)))
        m = protocol.parse_map("v=2 out=25 in=0 flags=0x00", lines)
        from pochi.types import VALID_DIO_MASK

        assert m.direction_mask == VALID_DIO_MASK

    def test_parse_map_v2_channels_directly(self):
        lines = self._channel_lines({0, 23})
        mask = protocol.parse_map_v2_channels(lines)
        assert mask == (1 << 0) | (1 << 26)

    def test_wrong_line_count_rejected(self):
        with pytest.raises(ParseError):
            protocol.parse_map_v2_channels(["  ch0: OUT"])

    def test_malformed_channel_line_rejected(self):
        lines = self._channel_lines(set())
        lines[3] = "  ch3: SIDEWAYS"
        with pytest.raises(ParseError):
            protocol.parse_map_v2_channels(lines)

    def test_missing_v_field_rejected(self):
        with pytest.raises(ParseError):
            protocol.parse_map("out=4 in=21 flags=0x01")

    def test_v2_out_without_colon_does_not_crash_range_parse(self):
        # Regression: v2 `out=N` (no `:count`) must not hit the v1
        # `parse_range` ParseError path (E-01).
        m = protocol.parse_map("v=2 out=4 in=21 flags=0x01")
        assert m.out_count == 4

    def test_v2_missing_pull_field_does_not_crash(self):
        # Regression: v2 responses have no `pull=` field (E-02).
        m = protocol.parse_map("v=2 out=4 in=21 flags=0x01")
        assert isinstance(m, PinMapV2)


class TestMapV2ToHex:
    def test_serializes_32_bytes(self):
        m = PinMapV2(
            version=2,
            flags=0x01,
            direction_mask=0x0F,
            out_count=4,
            in_count=21,
            channels=[],
        )
        hex_str = protocol.map_v2_to_hex(m)
        assert len(hex_str) == 64
        data = bytes.fromhex(hex_str)
        assert data[0] == 2
        assert data[1] == 0x01
        assert data[2:4] == b"\x00\x00"
        assert int.from_bytes(data[4:8], "little") == 0x0F

    def test_defaults_use_valid_dio_mask_complement(self):
        from pochi.types import VALID_DIO_MASK

        direction_mask = 0x00000FFF
        m = PinMapV2(
            version=2,
            flags=0,
            direction_mask=direction_mask,
            out_count=12,
            in_count=13,
            channels=[],
        )
        data = bytes.fromhex(protocol.map_v2_to_hex(m))
        pull_up = int.from_bytes(data[8:12], "little")
        pull_down = int.from_bytes(data[12:16], "little")
        out_default = int.from_bytes(data[16:20], "little")
        out_polarity = int.from_bytes(data[20:24], "little")
        in_polarity = int.from_bytes(data[24:28], "little")
        edge_mask = int.from_bytes(data[28:32], "little")
        assert pull_up == 0
        assert pull_down == (~direction_mask & VALID_DIO_MASK)
        assert out_default == 0
        assert out_polarity == 0
        assert in_polarity == 0
        assert edge_mask == (~direction_mask & VALID_DIO_MASK)


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

    def test_pattern_timeout(self):
        from pochi.types import PatternTimeoutEvent

        assert protocol.parse_push_event(
            "PATTERN_TIMEOUT loops=42"
        ) == PatternTimeoutEvent(loops=42)
        assert protocol.parse_push_event(
            "PATTERN_TIMEOUT loops=0"
        ) == PatternTimeoutEvent(loops=0)

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
        "payload",
        [
            "INPUT t=99",
            "INPUT 0x05",
            "PATTERN_DONE loops=abc",
            "PATTERN_TIMEOUT",
            "PATTERN_TIMEOUT loops=xyz",
        ],
    )
    def test_malformed(self, payload):
        with pytest.raises(ParseError):
            protocol.parse_push_event(payload)
