"""Unit tests for the v2 command builders and strict response parsers.

Every parser is checked with a happy path, boundary values and malformed
input. The positive vectors are golden lines (``test_golden.py`` replays the
whole corpus); the negative vectors are hand-written malformed input, which
is the one place a hand-written device line is allowed (R-C4).
"""

import pytest

from pochi import protocol
from pochi.errors import (
    BadMapError,
    BadParamError,
    BusyError,
    FlashError,
    InvalidArgumentError,
    LineTooLongError,
    NoResourceError,
    NotArmedError,
    NotRunningError,
    ParseError,
    SyncStateError,
    TooLongError,
    UnknownCmdError,
    UnknownDeviceError,
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
)

# --- parse_response ---


class TestParseResponse:
    def test_ok_bare(self):
        r = protocol.parse_response("OK\r\n")
        assert (r.kind, r.data) == ("ok", "")

    def test_ok_data(self):
        r = protocol.parse_response("OK fw=0.1.3 proto=2")
        assert (r.kind, r.data) == ("ok", "fw=0.1.3 proto=2")

    def test_err(self):
        r = protocol.parse_response("ERR BAD_MAP")
        assert (r.kind, r.data) == ("err", "BAD_MAP")

    def test_push(self):
        r = protocol.parse_response("! INPUT in=0x00000005 t=99")
        assert (r.kind, r.data) == ("push", "INPUT in=0x00000005 t=99")

    @pytest.mark.parametrize("line", ["garbage", "OKAY nope", "", "  OK", "ok"])
    def test_garbage_rejected(self, line):
        with pytest.raises(ParseError):
            protocol.parse_response(line)

    def test_ok_data_maps_err_codes(self):
        with pytest.raises(BusyError):
            protocol.parse_response("ERR BUSY").ok_data()
        with pytest.raises(UnknownDeviceError):
            protocol.parse_response("ERR WHAT").ok_data()

    def test_ok_data_rejects_push_in_response_position(self):
        with pytest.raises(ParseError):
            protocol.parse_response("! INPUT in=0x0 t=1").ok_data()


class TestErrorMapping:
    @pytest.mark.parametrize(
        "code,cls",
        [
            ("BAD_PARAM", BadParamError),
            ("BAD_MAP", BadMapError),
            ("BUSY", BusyError),
            ("FLASH", FlashError),
            ("TOO_LONG", TooLongError),
            ("NOT_ARMED", NotArmedError),
            ("SYNC_STATE", SyncStateError),
            ("NO_RESOURCE", NoResourceError),
            ("NOT_RUNNING", NotRunningError),
            ("UNKNOWN_CMD", UnknownCmdError),
            ("LINE_TOO_LONG", LineTooLongError),
        ],
    )
    def test_each_text_error_has_its_own_class(self, code, cls):
        err = protocol.parse_response(f"ERR {code}").data
        assert type(protocol.from_error_code(err)) is cls
        assert protocol.from_error_code(err).code == code

    def test_unknown_name_is_preserved_not_defaulted(self):
        err = protocol.from_error_code("SYNC_TIMEOUT")
        assert type(err) is UnknownDeviceError
        assert "SYNC_TIMEOUT" in err.message


# --- count header ---


class TestCountField:
    def test_ok(self):
        assert protocol.parse_count_field("count=16") == 16
        assert protocol.parse_count_field("count=0") == 0

    @pytest.mark.parametrize(
        "data", ["", "n=1", "count=", "count=x", "count=-1", "count=1.5"]
    )
    def test_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_count_field(data)

    def test_ts_get_header(self):
        assert protocol.parse_ts_get_header("count=3 overflow=0") == (3, False)
        assert protocol.parse_ts_get_header("count=0 overflow=1") == (0, True)

    @pytest.mark.parametrize(
        "data",
        [
            "count=3",  # overflow= is part of the v2 header
            "overflow=0",
            "count=3 overflow=2",
            "count=3 overflow=0 extra=1",
            "count=3 count=3 overflow=0",
        ],
    )
    def test_ts_get_header_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_ts_get_header(data)


# --- version / caps / info / ping ---


class TestVersion:
    def test_ok(self):
        v = protocol.parse_version("fw=0.1.3 proto=2")
        assert (v.major, v.minor, v.patch, v.protocol_version) == (0, 1, 3, 2)

    def test_reports_other_protocol_without_judging_it(self):
        assert protocol.parse_version("fw=0.1.3 proto=1").protocol_version == 1

    @pytest.mark.parametrize(
        "data",
        [
            "",
            "fw=0.1.3",
            "proto=2",
            "fw=0.1 proto=2",
            "fw=a.b.c proto=2",
            "fw=0.1.3 proto=x",
            "fw=0.1.256 proto=2",
            "v0.1.3 proto=2",  # v1 spelling
            "fw=0.1.3 proto=2 extra=1",
        ],
    )
    def test_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_version(data)


class TestCaps:
    GOOD = "dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x00000003"

    def test_ok(self):
        c = protocol.parse_caps(self.GOOD)
        assert (c.dio, c.out, c.in_) == (25, 2, 23)
        assert (c.ts_res_ns, c.tick_ns, c.pattern_max, c.ring) == (40, 200, 256, 256)
        assert c.features == 3 and c.has_sync() and c.has_reset()

    def test_key_order_is_free(self):
        shuffled = " ".join(reversed(self.GOOD.split()))
        assert protocol.parse_caps(shuffled) == protocol.parse_caps(self.GOOD)

    @pytest.mark.parametrize(
        "data",
        [
            "",
            GOOD.replace("dio=25 ", ""),
            GOOD + " extra=1",
            GOOD.replace("ts_res_ns=40", "ts_res=40ns"),  # v1 key
            GOOD.replace("feat=0x00000003", "feat=zz"),
            GOOD.replace("out=2", "out=-2"),
            GOOD.replace("out=2", "out=2 out=3"),
            GOOD.replace("dio=25", "dio=256"),  # exceeds u8
            GOOD.replace("pattern=256", "pattern=65536"),  # exceeds u16
        ],
    )
    def test_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_caps(data)


class TestInfoAndPing:
    def test_info_assigned_and_unassigned(self):
        assert protocol.parse_info("uid=0123456789ABCDEF devnum=42") == (
            "0123456789ABCDEF",
            42,
        )
        assert protocol.parse_info("uid=0000000000000000 devnum=255") == (
            "0000000000000000",
            None,
        )
        assert protocol.parse_info("uid=0000000000000000 devnum=0")[1] == 0

    @pytest.mark.parametrize(
        "data",
        [
            "",
            "uid=0000000000000000",
            "devnum=1",
            "uid=00 devnum=1",
            "uid=000000000000000g devnum=1",
            "uid=0000000000000000 devnum=256",
            "uid=0000000000000000 devnum=x",
        ],
    )
    def test_info_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_info(data)

    def test_pong(self):
        assert protocol.parse_pong("pong=12345") == 12345
        assert protocol.parse_pong("pong=4294967295") == 0xFFFFFFFF

    @pytest.mark.parametrize("data", ["", "pong=", "pong=4294967296", "pong=-1", "x=1"])
    def test_pong_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_pong(data)

    def test_ping_command(self):
        assert protocol.ping_command(5) == "ping 5"
        assert protocol.ping_command(0xFFFFFFFF) == "ping 4294967295"
        for bad in (-1, 0x100000000):
            with pytest.raises(InvalidArgumentError):
                protocol.ping_command(bad)

    def test_devnum_command(self):
        assert protocol.devnum_command(0) == "devnum 0"
        assert protocol.devnum_command(255) == "devnum 255"
        for bad in (-1, 256):
            with pytest.raises(InvalidArgumentError):
                protocol.devnum_command(bad)


# --- map ---


class TestMap:
    GOOD = (
        "v=2 flags=0x00 dir=0x00000003 pu=0x00000000 pd=0x0c7ffffc def=0x00000000 "
        "opol=0x00000000 ipol=0x00000000 edge=0x0c7ffffc"
    )

    def test_parse(self):
        m = protocol.parse_map(self.GOOD)
        assert m.direction == 3
        assert m.pull_down == 0x0C7FFFFC
        assert m.to_set_args() == self.GOOD

    def test_decimal_values_accepted(self):
        data = self.GOOD.replace("dir=0x00000003", "dir=3")
        assert protocol.parse_map(data).direction == 3

    @pytest.mark.parametrize(
        "data",
        [
            "",
            GOOD.replace("v=2 ", ""),
            GOOD.replace("v=2", "v=1"),
            GOOD.replace("v=2", "v=3"),
            GOOD + " extra=1",
            GOOD.replace(" edge=0x0c7ffffc", ""),
            GOOD.replace("flags=0x00", "flags=0x100"),  # does not fit u8
            GOOD.replace("dir=0x00000003", "dir=0x100000000"),  # does not fit u32
            GOOD.replace("dir=0x00000003", "dir=0xzz"),
            GOOD.replace("dir=0x00000003", "dir=0x"),
            GOOD.replace("dir=0x00000003", "dir=-1"),
            GOOD.replace("dir=0x00000003", "dir="),
            GOOD.replace("pu=0x00000000", "pu=0x00000000 pu=0x00000000"),
            # R-M1 violated by the device report: dir bit 23
            GOOD.replace("dir=0x00000003", "dir=0x00800000"),
            "v=2 chN: OUT",  # v1/v2-draft detail style
            "OK v=2",
        ],
    )
    def test_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_map(data)

    def test_map_set_command(self):
        assert protocol.map_set_command(PinMap.default()) == (
            "map set v=2 flags=0x00 dir=0x00000000 pu=0x00000000 pd=0x0c7fffff "
            "def=0x00000000 opol=0x00000000 ipol=0x00000000 edge=0x0c7fffff"
        )

    def test_map_set_command_validates_first(self):
        with pytest.raises(InvalidArgumentError):
            protocol.map_set_command(PinMap(0, 0x00800000, 0, 0, 0, 0, 0, 0))


# --- read / write / state ---


class TestIo:
    def test_read(self):
        assert protocol.parse_read("in=0x000000f0") == 0xF0
        assert protocol.parse_read("in=5") == 5

    @pytest.mark.parametrize(
        "data", ["", "0x000000f0", "in=", "in=0xg", "out=1", "in=1 out=2"]
    )
    def test_read_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_read(data)

    def test_state(self):
        s = protocol.parse_state("in=0x00000030 out=0x00000005")
        assert (s.inputs, s.outputs) == (0x30, 5)

    @pytest.mark.parametrize(
        "data",
        [
            "",
            "in=0x1",
            "out=0x1",
            "in=0x1 out=0x1 flags=0x00",  # v1 key
            "in=0x1 out=0x100000000",
        ],
    )
    def test_state_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_state(data)

    def test_write_command(self):
        assert protocol.write_command(0x2, 0x3) == "write 0x2 0x3"
        assert protocol.write_command(0, 0x0C7FFFFF) == "write 0x0 0xc7fffff"

    @pytest.mark.parametrize(
        "values,mask", [(0x00800000, 1), (1, 0x10000000), (-1, 1), (1, 1 << 32)]
    )
    def test_write_command_rejects_non_dio_bits(self, values, mask):
        with pytest.raises(InvalidArgumentError):
            protocol.write_command(values, mask)


# --- pattern ---


class TestPattern:
    def test_add_single_line(self):
        lines = protocol.pattern_add_commands([PatternStep(1, 5), PatternStep(0, 10)])
        assert lines == ["pattern add 0x1:5 0x0:10"]

    def test_add_splits_at_the_256_byte_line_limit(self):
        steps = [PatternStep(0, 1)] * 256
        lines = protocol.pattern_add_commands(steps)
        assert all(len(line) <= protocol.MAX_LINE_BYTES for line in lines)
        assert sum(line.count(":") for line in lines) == 256
        # Greedy packing: only the last line may be shorter than needed.
        for line in lines[:-1]:
            assert len(line) + len(" 0x0:1") > protocol.MAX_LINE_BYTES
        assert lines[0].startswith("pattern add ")

    def test_add_line_of_exactly_256_bytes_is_kept_whole(self):
        # "pattern add" (11) + 35 x " 0x0:1" (6) + 5 x " 0x0:10" (7) = 256
        steps = [PatternStep(0, 1)] * 35 + [PatternStep(0, 10)] * 5
        lines = protocol.pattern_add_commands(steps)
        assert len(lines) == 1 and len(lines[0]) == 256

    def test_add_rejects_empty_and_bad_step_before_producing_anything(self):
        with pytest.raises(InvalidArgumentError):
            protocol.pattern_add_commands([])
        with pytest.raises(InvalidArgumentError):
            protocol.pattern_add_commands([PatternStep(0, 1), PatternStep(0, 0)])

    def test_total(self):
        assert protocol.parse_pattern_total("total=256") == 256

    @pytest.mark.parametrize(
        "data", ["", "total=", "total=65536", "accepted=2", "total=1 x=1"]
    )
    def test_total_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_pattern_total(data)

    def test_run_command(self):
        assert protocol.pattern_run_command(PatternMode.ONCE, 1) == "pattern run once"
        assert protocol.pattern_run_command(PatternMode.ONCE, 7) == "pattern run once"
        assert protocol.pattern_run_command(PatternMode.LOOP, 3) == "pattern run loop 3"
        assert (
            protocol.pattern_run_command(PatternMode.LOOP, 65535)
            == "pattern run loop 65535"
        )

    @pytest.mark.parametrize("repeat", [0, -1, 65536])
    def test_run_loop_repeat_range(self, repeat):
        with pytest.raises(InvalidArgumentError):
            protocol.pattern_run_command(PatternMode.LOOP, repeat)

    def test_status(self):
        s = protocol.parse_pattern_status("state=running step=1 loops=0 total=2")
        assert (s.state, s.step, s.loops, s.total) == (PatternState.RUNNING, 1, 0, 2)
        for name in ("idle", "loaded", "running", "done"):
            assert protocol.parse_pattern_status(
                f"state={name} step=0 loops=0 total=0"
            ).state is PatternState(name)

    @pytest.mark.parametrize(
        "data",
        [
            "",
            "state=idle step=0 loops=0",  # v1 shape: total is required
            "state=paused step=0 loops=0 total=0",
            "state=idle step=x loops=0 total=0",
            "state=idle step=0 loops=65536 total=0",
        ],
    )
    def test_status_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_pattern_status(data)


# --- timestamp ---


class TestTimestamp:
    def test_arm_command(self):
        assert protocol.ts_arm_command(0x1, EdgeMode.RISING) == "ts arm 0x1 rising"
        assert (
            protocol.ts_arm_command(0x0C000000, EdgeMode.BOTH)
            == "ts arm 0xc000000 both"
        )
        assert protocol.ts_arm_command(2, EdgeMode.FALLING) == "ts arm 0x2 falling"

    def test_arm_rejects_non_dio_bits(self):
        with pytest.raises(InvalidArgumentError):
            protocol.ts_arm_command(0x10000000, EdgeMode.BOTH)

    def test_get_command_range(self):
        assert protocol.ts_get_command(1) == "ts get 1"
        assert protocol.ts_get_command(85) == "ts get 85"
        for bad in (0, 86, -1):
            with pytest.raises(InvalidArgumentError):
                protocol.ts_get_command(bad)

    def test_status(self):
        s = protocol.parse_ts_status("armed=1 pending=256 overflow=1")
        assert (s.armed, s.pending, s.overflow) == (True, 256, True)
        assert protocol.parse_ts_status("armed=0 pending=0 overflow=0").armed is False

    @pytest.mark.parametrize(
        "data",
        [
            "",
            "armed=2 pending=0 overflow=0",
            "armed=1 pending=0",
            "armed=1 pending=x overflow=0",
        ],
    )
    def test_status_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_ts_status(data)

    def test_event_line(self):
        ev = protocol.parse_ts_event_line("  in=0x00000001 c=2 p=12 s=1")
        assert (ev.inputs, ev.raw_count, ev.raw_phase, ev.sync_active) == (
            1,
            2,
            12,
            True,
        )
        assert ev.ns(40) == 2480

    def test_event_line_boundaries(self):
        ev = protocol.parse_ts_event_line("  in=0x00000000 c=4294967295 p=24 s=0")
        assert (ev.raw_count, ev.raw_phase, ev.sync_active) == (0xFFFFFFFF, 24, False)

    @pytest.mark.parametrize(
        "line",
        [
            "",
            "  in=0x1 c=1 p=25 s=1",  # phase above 24
            "  in=0x1 c=1 p=0 s=2",
            "  in=0x1 c=4294967296 p=0 s=0",
            "  in=0x1 c=1 p=0",
            "  in=0x1 c=1 p=0 s=1 x=1",
            "  0x00000005 c=1000 p=7 s=1",  # pre-v2 bare input word
            "  in=0x1 t=1234567890",  # pre-Phase 9.6 time format
        ],
    )
    def test_event_line_rejects(self, line):
        with pytest.raises(ParseError):
            protocol.parse_ts_event_line(line)


# --- sync ---


class TestSync:
    def test_count(self):
        assert protocol.parse_sync_count("clocks=1000000") == 1000000
        assert protocol.parse_sync_count("clocks=18446744073709551615") == 2**64 - 1

    @pytest.mark.parametrize(
        "data",
        [
            "",
            "count=5",
            "clocks=",
            "clocks=-1",
            "clocks=18446744073709551616",
            "clocks=1 x=2",
        ],
    )
    def test_count_rejects(self, data):
        with pytest.raises(ParseError):
            protocol.parse_sync_count(data)


# --- push events ---


class TestPushEvents:
    def test_input(self):
        assert protocol.parse_push_event("INPUT in=0x00000001 t=5") == InputChangeEvent(
            inputs=1, t_us=5
        )
        big = protocol.parse_push_event("INPUT in=0x0c7fffff t=18446744073709551615")
        assert big.t_us == 2**64 - 1

    def test_pattern_done_and_timeout(self):
        assert protocol.parse_push_event("PATTERN_DONE loops=3") == PatternDoneEvent(
            loops=3
        )
        assert protocol.parse_push_event(
            "PATTERN_TIMEOUT loops=0"
        ) == PatternTimeoutEvent(loops=0)

    @pytest.mark.parametrize(
        "payload",
        [
            "INPUT",
            "INPUT in=0x1",
            "INPUT t=5",
            "INPUT garbage",
            "INPUT 0x00000001 t=5",  # v1 bare input word
            "INPUT in=0x1 t=x",
            "PATTERN_DONE",
            "PATTERN_DONE loops=x",
            "PATTERN_DONE loops=65536",
            "PATTERN_TIMEOUT",
        ],
    )
    def test_malformed_known_event_is_an_error(self, payload):
        with pytest.raises(ParseError):
            protocol.parse_push_event(payload)

    def test_unknown_event_name_is_an_error_not_a_value(self):
        # Unknown events are logged and discarded by the transport; the pure
        # parser reports them as a distinct error so the caller can tell.
        with pytest.raises(protocol.UnknownEventError):
            protocol.parse_push_event("SYNC_DONE status=ready devnum=1 ts=42")
        with pytest.raises(protocol.UnknownEventError):
            protocol.parse_push_event("")


def test_removed_v1_helpers_are_gone():
    for name in (
        "map_to_hex",
        "map_v2_to_hex",
        "pattern_to_hex",
        "parse_accepted",
        "parse_map_version",
        "parse_map_v2_channels",
        "parse_count_overflow_field",
        "parse_ts_event_line_v1",
    ):
        assert not hasattr(protocol, name)
