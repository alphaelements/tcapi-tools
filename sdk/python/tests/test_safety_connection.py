"""Safety functions on ``Connection``: wire text, typed results, host-side
validation, ``apply_safety`` (DD-16) and the golden conformance of every
typed method. Mirrors the safety tests of ``sdk/rust/src/connection.rs``
and ``sdk/rust/src/golden_api.rs``."""

from __future__ import annotations

import pytest

from pochi import Connection, config
from pochi.errors import (
    BadParamError,
    ExclusiveError,
    FailsafeError,
    InvalidArgumentError,
    ParseError,
    SafetyMismatchError,
    SdkError,
    TimeoutError_,
    from_error_code,
)
from pochi.safety import SafetyConfig
from pochi.types import FailsafeCause, Pads, ResetCause, ResetInfo, SafetyState

from .fake_port import FakePort
from .golden import GOLDEN_FILES, canon, first_response, parse_file
from .safety_device import SafetyDevice

FULL = SafetyConfig(watchdog_ms=800, usbsafe=True, groups=[0xC, 0x18])


def connect(dev: SafetyDevice) -> Connection:
    return Connection.from_port(dev.port)


# --- the model device speaks the golden shapes ---


def test_the_model_device_lines_equal_the_golden_shapes():
    initial = first_response("safety", "safety")
    assert SafetyDevice().safety_line() == initial[0]
    two = next(
        r
        for case in parse_file("safety")
        for r in case.requests
        if r.text == "excl get" and r.response[0] == "OK count=2"
    )
    assert SafetyDevice(groups=[0x3, 0xC]).excl_get_lines() == two.response


# --- wire text and parsed answers ---


def scripted(answers: dict[str, list[str]]) -> tuple[Connection, FakePort]:
    """A connection whose device answers ``version`` and each command of
    ``answers`` with the given lines (golden-shaped)."""
    port = FakePort()

    def on_command(line: str) -> None:
        if line == "version":
            port.feed(first_response("version-info", "version")[0])
        else:
            port.feed(*answers.get(line, ["ERR UNKNOWN_CMD"]))

    port.on_command = on_command
    return Connection.from_port(port), port


def test_safety_commands_send_the_documented_text_and_parse_the_answers():
    conn, port = scripted(
        {
            "safety": [
                "OK wdog_ms=500 remaining_ms=377 failsafe=0 cause=none usbsafe=1 excl=2"
            ],
            "rstinfo": ["OK cause=por uptime_ms=1500 boot=0x00000001"],
            "pads": ["OK out=0x00000005 pad=0x00000001"],
            "excl get": ["OK count=2", "  mask=0x0000000c", "  mask=0x00000018"],
            **{
                c: ["OK"]
                for c in (
                    "wdog 500",
                    "wdog 0",
                    "failsafe clear",
                    "outputs reset",
                    "excl set 0xc",
                    "excl clear",
                    "usbsafe on",
                    "usbsafe off",
                )
            },
        }
    )
    with conn:
        assert conn.wdog(500) is None
        conn.wdog(0)
        conn.failsafe_clear()
        conn.outputs_reset()
        conn.excl_set([0xC])
        conn.excl_clear()
        conn.usbsafe(True)
        conn.usbsafe(False)
        st = conn.safety()
        assert st == SafetyState(500, 377, False, FailsafeCause.NONE, True, 2)
        assert conn.excl_get() == [0xC, 0x18]
        assert conn.rstinfo() == ResetInfo(ResetCause.POR, 1500, 1)
        assert conn.pads() == Pads(out=5, pad=1)
    assert port.written == [
        "version",
        "wdog 500",
        "wdog 0",
        "failsafe clear",
        "outputs reset",
        "excl set 0xc",
        "excl clear",
        "usbsafe on",
        "usbsafe off",
        "safety",
        "excl get",
        "rstinfo",
        "pads",
    ]


def test_safety_commands_refuse_bad_arguments_without_sending():
    conn, port = scripted({})
    with conn:
        for call in (
            lambda: conn.wdog(99),
            lambda: conn.wdog(10_001),
            lambda: conn.excl_set([]),
            lambda: conn.excl_set([0x1]),
            lambda: conn.excl_set([0x3] * 17),
        ):
            with pytest.raises(InvalidArgumentError):
                call()
    assert port.written == ["version"]


def test_failsafe_and_exclusive_errors_are_typed_with_their_data():
    conn, _ = scripted(
        {
            "write 0x1 0x1": ["ERR FAILSAFE"],
            "write 0x8 0x8": ["ERR EXCLUSIVE group=1 mask=0x0000000c"],
            "wdog 100": ["ERR EXCLUSIVE group=0 mask=0x3 future=1"],
        }
    )
    with conn:
        with pytest.raises(FailsafeError):
            conn.write(1, 1)
        with pytest.raises(ExclusiveError) as info:
            conn.write(8, 8)
        assert (info.value.group, info.value.mask) == (1, 0xC)
        # Further key=value tokens never make the line unparseable.
        with pytest.raises(ExclusiveError) as info:
            conn.wdog(100)
        assert (info.value.group, info.value.mask) == (0, 3)


def test_a_malformed_exclusive_line_is_a_parse_error_not_a_default():
    conn, _ = scripted({"write 0x1 0x1": ["ERR EXCLUSIVE group=0"]})
    with conn, pytest.raises(ParseError):
        conn.write(1, 1)


def test_excl_get_with_a_short_counted_response_times_out_then_resyncs():
    conn, _ = scripted({"excl get": ["OK count=2", "  mask=0x3"]})
    with conn:
        conn.set_timeout(0.2)
        # The second line never arrives.
        with pytest.raises(TimeoutError_):
            conn.excl_get()


def test_excl_get_with_a_bare_ok_is_a_parse_error():
    conn, _ = scripted({"excl get": ["OK"]})
    with conn, pytest.raises(ParseError):
        conn.excl_get()


# --- apply_safety (DD-16) ---


def test_apply_safety_sends_dd16_order_then_reads_back():
    dev = SafetyDevice()
    with connect(dev) as conn:
        st = conn.apply_safety(FULL)
    assert dev.commands == [
        "version",
        "excl set 0xc 0x18",
        "usbsafe on",
        "wdog 800",
        "safety",
        "excl get",
    ]
    assert (st.wdog_ms, st.usbsafe, st.excl) == (800, True, 2)
    assert dev.groups == [0xC, 0x18]


def test_apply_safety_without_groups_clears_them_and_never_sets():
    dev = SafetyDevice(groups=[0x3])
    with connect(dev) as conn:
        conn.apply_safety(SafetyConfig())
    assert dev.commands == [
        "version",
        "excl clear",
        "usbsafe off",
        "wdog 0",
        "safety",
        "excl get",
    ]
    assert dev.groups == []


def test_apply_safety_never_sends_excl_clear_before_excl_set():
    dev = SafetyDevice(groups=[0x3])
    with connect(dev) as conn:
        conn.apply_safety(FULL)
    assert "excl clear" not in dev.commands


@pytest.mark.parametrize(
    "fail_on,sent",
    [
        ("excl set", ["excl set 0xc 0x18"]),
        ("usbsafe", ["excl set 0xc 0x18", "usbsafe on"]),
        ("wdog", ["excl set 0xc 0x18", "usbsafe on", "wdog 800"]),
    ],
)
def test_apply_safety_stops_at_the_first_error_and_reports_its_code(fail_on, sent):
    dev = SafetyDevice(fail_on=fail_on)
    with connect(dev) as conn, pytest.raises(BadParamError):
        conn.apply_safety(FULL)
    # No later command and no read-back after the error.
    assert dev.commands == ["version", *sent]


def test_apply_safety_refuses_an_invalid_config_before_sending_anything():
    dev = SafetyDevice()
    with connect(dev) as conn, pytest.raises(InvalidArgumentError):
        conn.apply_safety(SafetyConfig(watchdog_ms=50, usbsafe=True, groups=[0xC]))
    assert dev.commands == ["version"]


def test_apply_safety_detects_a_read_back_that_differs():
    dev = SafetyDevice(lie=True)
    with connect(dev) as conn, pytest.raises(SafetyMismatchError) as info:
        conn.apply_safety(FULL)
    assert "wdog_ms" in str(info.value) and "group 0" in str(info.value)


def test_apply_safety_detects_a_differing_usbsafe_alone():
    dev = SafetyDevice(lie_usbsafe=True)
    with connect(dev) as conn, pytest.raises(SafetyMismatchError) as info:
        conn.apply_safety(FULL)
    assert info.value.message.endswith("usbsafe is 0, expected 1")


@pytest.mark.parametrize(
    "extra,want",
    [
        (1, "excl get returned 3 groups, expected 2"),
        (-1, "excl get returned 1 groups, expected 2"),
    ],
)
def test_apply_safety_detects_excl_get_with_extra_or_missing_groups(extra, want):
    # `safety` reports the right `excl=` count; only `excl get` disagrees.
    dev = SafetyDevice(excl_get_extra=extra)
    with connect(dev) as conn, pytest.raises(SafetyMismatchError) as info:
        conn.apply_safety(FULL)
    assert info.value.message.endswith(want)


def test_apply_safety_applies_a_parsed_file():
    cfg = config.parse_safety(
        "version = 2\n[watchdog]\ntimeout_ms = 800\n[usb]\nsafe = true\n"
        "[[exclusive]]\npins = ['GP2', 'GP3']\n[[exclusive]]\npins = ['GP3', 'GP4']\n",
        "s.toml",
    )
    dev = SafetyDevice()
    with connect(dev) as conn:
        assert conn.apply_safety(cfg).wdog_ms == 800
    assert dev.commands[1:4] == ["excl set 0xc 0x18", "usbsafe on", "wdog 800"]


def test_close_sends_nothing():
    dev = SafetyDevice()
    conn = connect(dev)
    conn.apply_safety(FULL)
    before = dev.commands
    conn.close()
    assert dev.commands == before


# --- every golden exchange through the typed methods ---


class ScriptedRig:
    """A connection over a port that answers the next command with the
    transcript's recorded response."""

    def __init__(self) -> None:
        self.port = FakePort()
        self.response: list[str] | None = None
        self.port.on_command = self._on_command
        self.conn = Connection.from_port(self.port)
        self.conn.set_timeout(2.0)

    def _on_command(self, line: str) -> None:
        if line == "version":
            self.port.feed(first_response("version-info", "version")[0])
        elif self.response is not None:
            self.port.feed(*self.response)
        else:
            self.port.feed("ERR UNKNOWN_CMD")


def num32(text: str) -> int | None:
    try:
        value = int(text, 0)
    except ValueError:
        return None
    return value if 0 <= value <= 0xFFFFFFFF else None


def dispatch(conn: Connection, request: str):
    """The typed call for a golden request, or ``None`` when no typed method
    can express it (malformed text, abbreviations)."""
    words = request.lower().split()
    match words:
        case ["wdog", ms] if (n := num32(ms)) is not None:
            return "wdog", lambda: conn.wdog(n)
        case ["safety"]:
            return "safety", conn.safety
        case ["failsafe", "clear"]:
            return "failsafe_clear", conn.failsafe_clear
        case ["outputs", "reset"]:
            return "outputs_reset", conn.outputs_reset
        case ["excl", "set", *masks] if masks and all(
            num32(m) is not None for m in masks
        ):
            values = [num32(m) for m in masks]
            return "excl_set", lambda: conn.excl_set(values)
        case ["excl", "clear"]:
            return "excl_clear", conn.excl_clear
        case ["excl", "get"]:
            return "excl_get", conn.excl_get
        case ["usbsafe", "on"]:
            return "usbsafe", lambda: conn.usbsafe(True)
        case ["usbsafe", "off"]:
            return "usbsafe", lambda: conn.usbsafe(False)
        case ["rstinfo"]:
            return "rstinfo", conn.rstinfo
        case ["pads"]:
            return "pads", conn.pads
    return None


def safety_exchanges():
    for name in GOLDEN_FILES:
        for case in parse_file(name):
            for req in case.requests:
                if req.response:
                    yield f"{name}.txt:{req.line_no}", req


def test_typed_safety_methods_agree_with_every_golden_exchange():
    rig = ScriptedRig()
    exercised: set[str] = set()
    local_rejections = 0
    for at, req in safety_exchanges():
        rig.response = req.response
        found = dispatch(rig.conn, req.text)
        if found is None:
            continue
        method, call = found
        exercised.add(method)
        sent_before = len(rig.port.written)
        header = req.response[0]
        where = f"{at} `{req.text}`"
        try:
            call()
        except InvalidArgumentError:
            # Refused on the host before sending; the device answers ERR too.
            assert header.startswith("ERR "), where
            assert len(rig.port.written) == sent_before, where
            local_rejections += 1
            continue
        except SdkError as exc:
            assert header.startswith("ERR "), f"{where}: {exc}"
            want = from_error_code(header[4:])
            assert type(exc) is type(want) and str(exc) == str(want), where
        else:
            assert header.startswith("OK"), f"{where}: method succeeded on {header}"
        sent = rig.port.written[sent_before:]
        assert len(sent) == 1, f"{where}: sent {sent}"
        assert canon(sent[0]) == canon(req.text), where
    assert exercised == {
        "wdog",
        "safety",
        "failsafe_clear",
        "outputs_reset",
        "excl_set",
        "excl_clear",
        "excl_get",
        "usbsafe",
        "rstinfo",
        "pads",
    }
    assert local_rejections > 0
    rig.conn.close()
