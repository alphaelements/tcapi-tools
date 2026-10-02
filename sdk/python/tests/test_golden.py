"""Conformance against the golden transcripts (docs/sdk-api-design.md
section 8, R-C4): the files in ``protocol/golden/`` are the same ones the
firmware and the simulator replay, so a parser that rejects a line the
firmware sends, a validator that disagrees with the device, or a transport
that mis-frames a response fails here."""

import time
from collections import Counter

import pytest

from pochi import protocol
from pochi.errors import InvalidArgumentError
from pochi.protocol import parse_response
from pochi.transport import Transport
from pochi.types import (
    PatternState,
    PatternStep,
    PinMap,
    PushEvent,
)

from .golden import (
    GOLDEN_FILES,
    Case,
    ReplayPort,
    canon,
    find_case,
    load_cases,
    parse_file,
)

CASES = load_cases()


def form_of(request: str) -> str:
    words = request.split()
    if not words:
        return ""
    first = words[0].lower()
    if first in ("map", "pattern", "ts", "sync", "subscribe"):
        return " ".join(w.lower() for w in words[:2])
    return first


def check_ok(form: str, data: str, lines: list[str], seen: set[str]) -> None:
    if form == "version":
        assert protocol.parse_version(data).protocol_version == 2
    elif form == "caps":
        c = protocol.parse_caps(data)
        assert (c.dio, c.ts_res_ns, c.tick_ns, c.pattern_max, c.ring) == (
            25,
            40,
            200,
            256,
            256,
        )
        assert c.features == 3 and c.has_sync() and c.has_reset()
        assert c.out + c.in_ == c.dio
    elif form == "info":
        assert protocol.parse_info(data)[0] == "0000000000000000"
    elif form == "ping":
        protocol.parse_pong(data)
    elif form == "read":
        protocol.parse_read(data)
    elif form == "state":
        protocol.parse_state(data)
    elif form == "map get":
        pin_map = PinMap.parse_get(data)
        # R-M3: the payload pastes back into `map set` unchanged.
        assert pin_map.to_set_args() == data
    elif form == "pattern add":
        protocol.parse_pattern_total(data)
    elif form == "pattern status":
        s = protocol.parse_pattern_status(data)
        assert s.total <= 256
        if s.state is PatternState.IDLE:
            assert s.total == 0
    elif form == "ts get":
        count, _overflow = protocol.parse_ts_get_header(data)
        assert len(lines) == count
        for line in lines:
            assert line.startswith("  ")
            assert protocol.parse_ts_event_line(line).raw_phase <= 24
    elif form == "ts status":
        protocol.parse_ts_status(data)
    elif form == "sync count":
        protocol.parse_sync_count(data)
    elif form == "help":
        assert len(lines) == protocol.parse_count_field(data)
    elif form in {
        "devnum", "map set", "map save", "map default", "write", "pattern run",
        "pattern stop", "pattern reset", "ts arm", "ts disarm", "subscribe on",
        "subscribe off", "sync arm", "sync master", "sync start", "sync stop",
        "sync disarm", "reset", "bootsel",
    }:  # fmt: skip
        assert data == "", f"bare OK expected for {form!r}"
    else:
        raise AssertionError(f"golden response for unhandled form {form!r}: OK {data}")
    seen.add(form)


def test_every_golden_response_parses():
    seen_forms: set[str] = set()
    seen_errors: Counter[str] = Counter()
    seen_events: set[str] = set()
    ok_lines = 0
    for case in CASES:
        for step in case.steps:
            if hasattr(step, "wire"):
                event = protocol.parse_push_event(step.wire[2:])
                seen_events.add(type(event).__name__)
                continue
            if not hasattr(step, "response") or not step.response:
                continue
            header = parse_response(step.response[0])
            if header.kind == "err":
                err = protocol.from_error_code(header.data)
                assert type(err).__name__ != "UnknownDeviceError", (
                    f"{case.file}.txt:{step.line_no}: {header.data} has no typed error"
                )
                seen_errors[header.data] += 1
            else:
                check_ok(form_of(step.text), header.data, step.response[1:], seen_forms)
                ok_lines += 1
    assert ok_lines > 500
    assert {"version", "caps", "info", "ping", "read", "state", "map get", "map set",
            "pattern add", "pattern status", "ts get", "ts status", "sync count", "help",
            "devnum", "write"} <= seen_forms  # fmt: skip
    assert seen_events == {
        "InputChangeEvent",
        "PatternDoneEvent",
        "PatternTimeoutEvent",
    }
    for code in ("BAD_PARAM", "BAD_MAP", "BUSY", "FLASH", "TOO_LONG", "NOT_ARMED",
                 "SYNC_STATE", "NO_RESOURCE", "NOT_RUNNING", "UNKNOWN_CMD", "LINE_TOO_LONG"):  # fmt: skip
        assert seen_errors[code] > 0, f"golden never exercised {code}"


# --- R-M1: PinMap.validate agrees with the device ---


def map_set_requests():
    for case in CASES:
        for req in case.requests:
            words = req.text.split()
            if (
                len(words) >= 3
                and words[0].lower() == "map"
                and words[1].lower() == "set"
            ):
                yield case, req


def to_pin_map(request: str) -> PinMap | None:
    """The request as a PinMap when it carries all eight keys with u32
    values; ``None`` for the malformed forms the device answers BAD_PARAM."""
    names = {
        "flags": "flags", "dir": "direction", "pu": "pull_up", "pd": "pull_down",
        "def": "out_default", "opol": "out_polarity", "ipol": "in_polarity", "edge": "edge",
    }  # fmt: skip
    values: dict[str, int] = {}
    for tok in request.split()[2:]:
        key, sep, val = tok.partition("=")
        key = key.lower()
        if key == "v" and val == "2":
            continue
        if not sep or key not in names or names[key] in values:
            return None
        try:
            number = int(val, 0)
        except ValueError:
            return None
        if not 0 <= number <= 0xFFFFFFFF:
            return None
        values[names[key]] = number
    if len(values) != 8 or values["flags"] > 0xFF:
        return None
    return PinMap(**values)


def test_validate_agrees_with_every_golden_map_set():
    accepted = rejected = 0
    for case, req in map_set_requests():
        status = parse_response(req.response[0])
        pin_map = to_pin_map(req.text)
        where = f"{case.file}.txt:{req.line_no} {req.text}"
        if status.kind == "ok":
            assert pin_map is not None, where
            pin_map.validate()  # must not raise
            assert canon(protocol.map_set_command(pin_map)) == canon(req.text), where
            accepted += 1
        elif status.data == "BAD_MAP":
            assert pin_map is not None, where
            with pytest.raises(InvalidArgumentError):
                pin_map.validate()
            rejected += 1
        # BAD_PARAM / BUSY / FLASH forms are not map-validity rules.
    assert accepted >= 15
    assert rejected >= 20  # one transcript per R-M1 rule


def test_every_golden_map_get_is_a_valid_map():
    n = 0
    for case in CASES:
        for req in case.requests:
            if req.text.lower() == "map get" and req.response[0].startswith("OK"):
                PinMap.parse_get(req.response[0][3:]).validate()
                n += 1
    assert n >= 20


# --- command builders reproduce the transcripts ---


def test_pattern_add_commands_reproduce_the_256_step_transcript():
    case = find_case("boundary", "256 pattern steps are accepted")
    golden_lines = [r.text for r in case.requests if r.text.startswith("pattern add")]
    golden_lines = golden_lines[:-1]  # the 257th step is a separate, refused request
    assert len(golden_lines) == 7
    assert protocol.pattern_add_commands([PatternStep(0, 1)] * 256) == golden_lines


def test_write_and_arm_commands_match_canonical_golden_spelling():
    assert protocol.write_command(0x2, 0x3) == "write 0x2 0x3"
    spellings = {r.text for c in CASES for r in c.requests}
    assert "write 0x2 0x3" in spellings
    assert "ts arm 0x1 both" in spellings
    from pochi.types import EdgeMode

    assert protocol.ts_arm_command(0x1, EdgeMode.BOTH) == "ts arm 0x1 both"
    assert "pattern run loop 3" in spellings
    from pochi.types import PatternMode

    assert protocol.pattern_run_command(PatternMode.LOOP, 3) == "pattern run loop 3"
    assert "pattern run once" in spellings
    assert protocol.pattern_run_command(PatternMode.ONCE, 1) == "pattern run once"


# --- the transport frames every transcript ---


def wait_until(predicate, timeout=1.0):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.005)
    return predicate()


def replay_through_transport(case: Case) -> None:
    port = ReplayPort(case, handshake=False)
    transport = Transport(port)
    transport.timeout = 2.0
    received: list[PushEvent] = []
    transport.set_event_callback(received.append)
    try:
        for req in case.requests:
            assert transport.raw_exchange(req.text) == req.response, (
                f"{case.file}.txt:{req.line_no}: {req.text}"
            )
        assert port.mismatches == []
        assert port.exhausted
        expected = [protocol.parse_push_event(e.wire[2:]) for e in case.events]
        assert wait_until(lambda: len(received) >= len(expected))
        assert received == expected, f"{case.file}.txt: {case.title}"
        assert not transport.desynced
    finally:
        port.close()  # wakes the reader thread so shutdown is immediate
        transport.close()


def replayable(case: Case) -> bool:
    return not case.binary and all(r.response for r in case.requests)


@pytest.mark.parametrize("name", GOLDEN_FILES)
def test_transport_replays_every_text_case(name):
    cases = [c for c in parse_file(name) if replayable(c)]
    assert cases, name
    for case in cases:
        replay_through_transport(case)


def test_only_binary_framing_cases_are_skipped():
    skipped = [c for c in CASES if not replayable(c)]
    # R-T5 binary / partial-line cases cannot be written as text lines.
    assert all(c.file == "boundary" for c in skipped)
    assert len(skipped) <= 14
    assert len(CASES) - len(skipped) > 250


def test_help_and_ts_get_are_the_only_counted_responses():
    counted = {
        req.text.split()[0].lower()
        + (" get" if req.text.lower().startswith("ts") else "")
        for case in CASES
        for req in case.requests
        if req.response and "count=" in req.response[0]
    }
    assert counted == {"ts get", "help"}
