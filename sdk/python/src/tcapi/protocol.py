"""Command builders and typed response parsers for the v2 CDC text
protocol. Pure functions (no I/O) — every parser is unit-testable without a
device. Mirrors ``sdk/rust/src/protocol.rs``.

Parsers are strict (R-P6): a response must carry exactly the documented
keys, no more and no fewer, and numbers must be in range. Anything else is a
:class:`~tcapi.errors.ParseError`, never a silently defaulted value.
Transport-level framing (line reads, counted reads) lives in
:mod:`tcapi.transport`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .errors import (
    InvalidArgumentError,
    ParseError,
    SdkError,
    UnknownEventError,
    from_error_code,
)
from .types import (
    MAX_EXCLUSIVE_GROUPS,
    PROTO_VERSION,
    WDOG_MAX_MS,
    WDOG_MIN_MS,
    Capabilities,
    EdgeMode,
    FailsafeCause,
    FailsafeEvent,
    InputChangeEvent,
    IoState,
    Pads,
    PatternDoneEvent,
    PatternMode,
    PatternState,
    PatternStatus,
    PatternStep,
    PatternTimeoutEvent,
    PinMap,
    PushEvent,
    ResetCause,
    ResetInfo,
    SafetyState,
    TimestampEvent,
    TsStatus,
    VersionInfo,
    check_dio_mask,
)

#: Longest request line the device accepts, excluding the CR/LF terminator
#: (R-T1).
MAX_LINE_BYTES = 256

#: Highest valid ``p=`` (raw phase) value of a timestamp event.
_MAX_RAW_PHASE = 24

#: ``ts get <max>``: accepted range (a single response is limited by the
#: device line buffer).
TS_GET_MAX_EVENTS = 85

#: ``pattern run loop <repeat>``: accepted range (u16, no infinite mode).
PATTERN_LOOP_MAX = 0xFFFF

_U8 = 0xFF
_U16 = 0xFFFF
_U32 = 0xFFFFFFFF
_U64 = 0xFFFFFFFFFFFFFFFF

_DEC = re.compile(r"[0-9]+")
_HEX = re.compile(r"0[xX][0-9a-fA-F]+")
_UID = re.compile(r"[0-9a-fA-F]{16}")


@dataclass
class Response:
    """A single response line, classified. ``kind`` is ok / err / push."""

    kind: str
    data: str

    def ok_data(self) -> str:
        """Extract the data of an OK response, mapping ERR codes to typed
        errors. A push line here is a routing bug (parse error)."""
        if self.kind == "ok":
            return self.data
        if self.kind == "err":
            raise from_error_code(self.data)
        raise ParseError(f"unexpected push event in response position: ! {self.data}")


def parse_response(line: str) -> Response:
    """Classify one response line. Trailing CR/LF is tolerated."""
    trimmed = line.rstrip("\r\n")
    if trimmed == "OK":
        return Response("ok", "")
    if trimmed.startswith("OK "):
        return Response("ok", trimmed[3:])
    if trimmed.startswith("ERR "):
        return Response("err", trimmed[4:])
    if trimmed.startswith("! "):
        return Response("push", trimmed[2:])
    raise ParseError(f"unexpected response line: {trimmed}")


def parse_count_field(ok_data: str) -> int:
    """Extract ``count=N`` from the header of a counted multi-line response
    (``ts get``, ``help``)."""
    for part in ok_data.split():
        if part.startswith("count="):
            value = part[len("count=") :]
            if not _DEC.fullmatch(value):
                raise ParseError(f"invalid count= value: {ok_data}")
            return int(value)
    raise ParseError(f"missing count= field: {ok_data}")


# --- key=value field parsing ---


def _parse_number(text: str) -> int | None:
    """A number given as decimal or ``0x`` hex. Digits only: no sign, no
    whitespace, no empty digit string. ``None`` when malformed."""
    if _HEX.fullmatch(text):
        return int(text, 16)
    if _DEC.fullmatch(text):
        return int(text)
    return None


class _Fields:
    """The ``key=value`` fields of one response, checked against the exact
    key set the protocol documents for it (order is free)."""

    def __init__(self, ctx: str, data: str, keys: tuple[str, ...]) -> None:
        self.ctx = ctx
        self.data = data
        self.pairs: dict[str, str] = {}
        for token in data.split():
            key, sep, value = token.partition("=")
            if not sep:
                raise self._error(f"token without '=' ({token})")
            if key not in keys:
                raise self._error(f"unexpected key {key}=")
            if key in self.pairs:
                raise self._error(f"duplicate key {key}=")
            self.pairs[key] = value
        for key in keys:
            if key not in self.pairs:
                raise self._error(f"missing {key}= field")

    def _error(self, msg: str) -> ParseError:
        return ParseError(f"{msg} in {self.ctx}: {self.data}")

    def _invalid(self, key: str) -> ParseError:
        return ParseError(f"invalid {key}= value in {self.ctx}: {self.data}")

    def raw(self, key: str) -> str:
        return self.pairs[key]

    def dec(self, key: str, maximum: int) -> int:
        """Plain decimal integer up to ``maximum``."""
        value = self.pairs[key]
        if not _DEC.fullmatch(value) or int(value) > maximum:
            raise self._invalid(key)
        return int(value)

    def mask(self, key: str, maximum: int = _U32) -> int:
        """Mask or bit value: ``0x`` hex (canonical) or decimal."""
        number = _parse_number(self.pairs[key])
        if number is None or number > maximum:
            raise self._invalid(key)
        return number

    def flag(self, key: str) -> bool:
        """``0`` or ``1``."""
        value = self.pairs[key]
        if value == "0":
            return False
        if value == "1":
            return True
        raise self._invalid(key)


# --- version ---


def parse_version(data: str) -> VersionInfo:
    """Parse ``fw=0.1.3 proto=2``.

    The protocol number is returned as reported; callers decide whether it
    is supported (see :data:`tcapi.types.PROTO_VERSION`)."""
    f = _Fields("version", data, ("fw", "proto"))
    parts = f.raw("fw").split(".")
    if len(parts) != 3 or not all(_DEC.fullmatch(p) and int(p) <= _U8 for p in parts):
        raise f._invalid("fw")
    major, minor, patch = (int(p) for p in parts)
    return VersionInfo(
        major=major,
        minor=minor,
        patch=patch,
        protocol_version=f.dec("proto", _U8),
    )


# --- caps ---


def parse_caps(data: str) -> Capabilities:
    """Parse ``dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=256
    ring=256 feat=0x00000003``."""
    f = _Fields(
        "caps",
        data,
        ("dio", "out", "in", "ts_res_ns", "tick_ns", "pattern", "ring", "feat"),
    )
    return Capabilities(
        dio=f.dec("dio", _U8),
        out=f.dec("out", _U8),
        in_=f.dec("in", _U8),
        ts_res_ns=f.dec("ts_res_ns", _U32),
        tick_ns=f.dec("tick_ns", _U32),
        pattern_max=f.dec("pattern", _U16),
        ring=f.dec("ring", _U16),
        features=f.mask("feat"),
    )


# --- info / devnum / ping ---


def parse_info(data: str) -> tuple[str, int | None]:
    """Parse ``uid=0123456789ABCDEF devnum=42``. devnum 255 (unassigned)
    maps to ``None``."""
    f = _Fields("info", data, ("uid", "devnum"))
    uid = f.raw("uid")
    if not _UID.fullmatch(uid):
        raise f._invalid("uid")
    devnum = f.dec("devnum", _U8)
    return uid, None if devnum == 255 else devnum


def devnum_command(n: int) -> str:
    """Build the ``devnum <n>`` command (0-254; 255 unassigns)."""
    if not 0 <= n <= _U8:
        raise InvalidArgumentError(f"device number {n} is out of range (0-255)")
    return f"devnum {n}"


def parse_pong(data: str) -> int:
    """Parse the ``ping`` response ``pong=<u32>``."""
    return _Fields("ping", data, ("pong",)).dec("pong", _U32)


def ping_command(value: int) -> str:
    """Build the ``ping <u32>`` command."""
    if not 0 <= value <= _U32:
        raise InvalidArgumentError(f"ping value {value} is not a u32")
    return f"ping {value}"


# --- map ---


def parse_map(data: str) -> PinMap:
    """Parse the ``map get`` response ``v=2 flags=0x00 dir=... edge=...`` and
    validate it (R-M1): a device reporting an invalid or non-v2 map is an
    error, not a value."""
    f = _Fields(
        "map",
        data,
        ("v", "flags", "dir", "pu", "pd", "def", "opol", "ipol", "edge"),
    )
    version = f.dec("v", _U8)
    if version != PROTO_VERSION:
        raise ParseError(f"unsupported map version v={version} in map: {data}")
    pin_map = PinMap(
        flags=f.mask("flags", _U8),
        direction=f.mask("dir"),
        pull_up=f.mask("pu"),
        pull_down=f.mask("pd"),
        out_default=f.mask("def"),
        out_polarity=f.mask("opol"),
        in_polarity=f.mask("ipol"),
        edge=f.mask("edge"),
    )
    try:
        pin_map.validate()
    except InvalidArgumentError as exc:
        raise ParseError(
            f"device reported an invalid map ({exc.message}): {data}"
        ) from exc
    return pin_map


def map_set_command(pin_map: PinMap) -> str:
    """Build the ``map set`` command for ``pin_map`` (validated first)."""
    return f"map set {pin_map.to_set_args()}"


# --- read / write / state ---


def parse_read(data: str) -> int:
    """Parse the ``read`` response ``in=0x00000005``."""
    return _Fields("read", data, ("in",)).mask("in")


def parse_state(data: str) -> IoState:
    """Parse the ``state`` response ``in=0x00000000 out=0x00000005``."""
    f = _Fields("state", data, ("in", "out"))
    return IoState(inputs=f.mask("in"), outputs=f.mask("out"))


def write_command(values: int, mask: int) -> str:
    """Build the ``write <values> <mask>`` command. Both words must stay
    within the DIO pins (R-PIN2)."""
    check_dio_mask("write values", values)
    check_dio_mask("write mask", mask)
    return f"write {values:#x} {mask:#x}"


# --- pattern ---


def pattern_add_commands(steps: list[PatternStep]) -> list[str]:
    """Build the ``pattern add`` command lines for ``steps``.

    Steps are packed greedily so every line stays within
    :data:`MAX_LINE_BYTES`; each line is applied atomically by the device
    (R-PT3). Every step is validated first, so nothing is produced for a bad
    pattern."""
    if not steps:
        raise InvalidArgumentError("pattern must have at least one step")
    prefix = "pattern add"
    lines: list[str] = []
    line = prefix
    for step in steps:
        text = step.to_text()
        # +1 for the separating space.
        if len(line) + 1 + len(text) > MAX_LINE_BYTES:
            lines.append(line)
            line = prefix
        line += " " + text
    lines.append(line)
    return lines


def parse_pattern_total(data: str) -> int:
    """Parse the ``pattern add`` response ``total=<n>``: steps now in the
    buffer."""
    return _Fields("pattern add", data, ("total",)).dec("total", _U16)


def pattern_run_command(mode: PatternMode, repeat: int) -> str:
    """Build the ``pattern run`` command string. ``once`` plays a single
    pass and ignores ``repeat``; ``loop`` requires 1-65535."""
    if mode is PatternMode.ONCE:
        return "pattern run once"
    if not 1 <= repeat <= PATTERN_LOOP_MAX:
        raise InvalidArgumentError(
            f"loop repeat {repeat} is out of range (1-{PATTERN_LOOP_MAX})"
        )
    return f"pattern run loop {repeat}"


def parse_pattern_status(data: str) -> PatternStatus:
    """Parse ``state=running step=5 loops=3 total=40``."""
    f = _Fields("pattern status", data, ("state", "step", "loops", "total"))
    state = f.raw("state")
    try:
        parsed_state = PatternState(state)
    except ValueError:
        raise ParseError(f"unknown pattern state: {state}") from None
    return PatternStatus(
        state=parsed_state,
        step=f.dec("step", _U16),
        loops=f.dec("loops", _U16),
        total=f.dec("total", _U16),
    )


# --- timestamp ---


def ts_arm_command(mask: int, mode: EdgeMode) -> str:
    """Build the ``ts arm`` command string. The mask must be non-zero and
    stay within the DIO pins (R-PIN2)."""
    check_dio_mask("ts arm mask", mask)
    if mask == 0:
        raise InvalidArgumentError("ts arm mask must not be empty")
    return f"ts arm {mask:#x} {mode.value}"


def ts_get_command(max_events: int) -> str:
    """Build the ``ts get <max>`` command (1-85 events per response)."""
    if not 1 <= max_events <= TS_GET_MAX_EVENTS:
        raise InvalidArgumentError(
            f"ts get max {max_events} is out of range (1-{TS_GET_MAX_EVENTS})"
        )
    return f"ts get {max_events}"


def parse_ts_status(data: str) -> TsStatus:
    """Parse the ``ts status`` response ``armed=1 pending=2 overflow=0``."""
    f = _Fields("ts status", data, ("armed", "pending", "overflow"))
    return TsStatus(
        armed=f.flag("armed"),
        pending=f.dec("pending", _U32),
        overflow=f.flag("overflow"),
    )


def parse_ts_get_header(data: str) -> tuple[int, bool]:
    """Parse the header of a ``ts get`` response, ``count=3 overflow=0``,
    into the number of event lines that follow and the ring-overflow flag."""
    f = _Fields("ts get", data, ("count", "overflow"))
    return f.dec("count", _U32), f.flag("overflow")


def parse_ts_event_line(line: str) -> TimestampEvent:
    """Parse one ``ts get`` event line: ``in=0x00000001 c=1000 p=7 s=1``
    (surrounding whitespace, including the two leading spaces of a
    continuation line, is ignored)."""
    f = _Fields("ts event", line.strip(), ("in", "c", "p", "s"))
    raw_phase = f.dec("p", _U8)
    if raw_phase > _MAX_RAW_PHASE:
        raise f._invalid("p")
    return TimestampEvent(
        inputs=f.mask("in"),
        raw_count=f.dec("c", _U32),
        raw_phase=raw_phase,
        sync_active=f.flag("s"),
    )


# --- sync ---


def parse_sync_count(data: str) -> int:
    """Parse the ``sync count`` response ``clocks=1000000``."""
    return _Fields("sync count", data, ("clocks",)).dec("clocks", _U64)


# --- safety functions ---


def wdog_command(ms: int) -> str:
    """Build ``wdog <ms>``: ``0`` disables the watchdog, ``100..=10000``
    enables it. Any other value is refused before sending (the device
    answers ``BAD_PARAM``)."""
    if ms != 0 and not WDOG_MIN_MS <= ms <= WDOG_MAX_MS:
        raise InvalidArgumentError(
            f"watchdog timeout {ms} ms must be 0 or between "
            f"{WDOG_MIN_MS} and {WDOG_MAX_MS}"
        )
    return f"wdog {ms}"


def usbsafe_command(on: bool) -> str:
    """Build ``usbsafe on|off``."""
    return f"usbsafe {'on' if on else 'off'}"


def excl_set_command(masks: list[int]) -> str:
    """Build ``excl set <mask>...``: 1 to 16 groups, each a subset of the DIO
    pins with at least 2 bits. That every pin is an *output* depends on the
    active map and is checked by the device."""
    if not 1 <= len(masks) <= MAX_EXCLUSIVE_GROUPS:
        raise InvalidArgumentError(
            f"excl set takes 1 to {MAX_EXCLUSIVE_GROUPS} groups, got {len(masks)}"
        )
    for i, mask in enumerate(masks):
        check_dio_mask(f"exclusive group {i} mask", mask)
        if mask.bit_count() < 2:
            raise InvalidArgumentError(
                f"exclusive group {i} mask {mask:#010x} needs at least 2 pins"
            )
    return "excl set " + " ".join(f"{m:#x}" for m in masks)


def parse_safety(data: str) -> SafetyState:
    """Parse the ``safety`` response
    ``wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0``.
    The latch and its cause must agree: ``failsafe=1`` has a cause other
    than ``none``, ``failsafe=0`` has cause ``none``."""
    f = _Fields(
        "safety",
        data,
        ("wdog_ms", "remaining_ms", "failsafe", "cause", "usbsafe", "excl"),
    )
    try:
        cause = FailsafeCause(f.raw("cause"))
    except ValueError:
        raise f._invalid("cause") from None
    failsafe = f.flag("failsafe")
    if failsafe == (cause is FailsafeCause.NONE):
        raise ParseError(f"failsafe latch and cause disagree in safety: {data}")
    excl = f.dec("excl", _U8)
    if excl > MAX_EXCLUSIVE_GROUPS:
        raise f._invalid("excl")
    return SafetyState(
        wdog_ms=f.dec("wdog_ms", _U32),
        remaining_ms=f.dec("remaining_ms", _U32),
        failsafe=failsafe,
        cause=cause,
        usbsafe=f.flag("usbsafe"),
        excl=excl,
    )


def parse_rstinfo(data: str) -> ResetInfo:
    """Parse the ``rstinfo`` response ``cause=por uptime_ms=0
    boot=0x00000001``."""
    f = _Fields("rstinfo", data, ("cause", "uptime_ms", "boot"))
    try:
        cause = ResetCause(f.raw("cause"))
    except ValueError:
        raise f._invalid("cause") from None
    return ResetInfo(
        cause=cause, uptime_ms=f.dec("uptime_ms", _U64), boot=f.mask("boot")
    )


def parse_pads(data: str) -> Pads:
    """Parse the ``pads`` response ``out=0x00000005 pad=0x00000005``."""
    f = _Fields("pads", data, ("out", "pad"))
    return Pads(out=f.mask("out"), pad=f.mask("pad"))


def parse_excl_get(header: str, lines: list[str]) -> list[int]:
    """Parse the counted ``excl get`` response: the header ``count=<n>`` and
    ``n`` lines ``  mask=0x%08x``, in the order the groups were set."""
    count = _Fields("excl get", header, ("count",)).dec("count", _U32)
    if count > MAX_EXCLUSIVE_GROUPS:
        raise ParseError(
            f"excl get announced {count} groups, the device holds at most "
            f"{MAX_EXCLUSIVE_GROUPS}"
        )
    if count != len(lines):
        raise ParseError(
            f"excl get header announced {count} groups but {len(lines)} lines were read"
        )
    return [
        _Fields("excl get line", line.strip(), ("mask",)).mask("mask") for line in lines
    ]


# --- push events ---


def parse_push_event(payload: str) -> PushEvent:
    """Parse the payload of a push line (after ``! ``).

    A recognized event with malformed fields is a
    :class:`~tcapi.errors.ParseError`; an event name the protocol does not
    define is an :class:`~tcapi.errors.UnknownEventError` (the transport
    logs and discards it)."""
    trimmed = payload.strip()
    kind, _, rest = trimmed.partition(" ")
    if kind == "INPUT":
        f = _Fields("INPUT event", rest, ("in", "t"))
        return InputChangeEvent(inputs=f.mask("in"), t_us=f.dec("t", _U64))
    if kind == "PATTERN_DONE":
        f = _Fields("PATTERN_DONE event", rest, ("loops",))
        return PatternDoneEvent(loops=f.dec("loops", _U16))
    if kind == "PATTERN_TIMEOUT":
        f = _Fields("PATTERN_TIMEOUT event", rest, ("loops",))
        return PatternTimeoutEvent(loops=f.dec("loops", _U16))
    if kind == "FAILSAFE":
        f = _Fields("FAILSAFE event", rest, ("cause",))
        # A trip always has a cause; `none` is only the idle `safety` value.
        try:
            cause = FailsafeCause(f.raw("cause"))
        except ValueError:
            raise f._invalid("cause") from None
        if cause is FailsafeCause.NONE:
            raise f._invalid("cause")
        return FailsafeEvent(cause=cause)
    raise UnknownEventError(f"unknown event: {trimmed}")


__all__ = [
    "MAX_LINE_BYTES",
    "PATTERN_LOOP_MAX",
    "TS_GET_MAX_EVENTS",
    "Response",
    "SdkError",
    "UnknownEventError",
    "devnum_command",
    "excl_set_command",
    "from_error_code",
    "map_set_command",
    "parse_caps",
    "parse_count_field",
    "parse_excl_get",
    "parse_info",
    "parse_map",
    "parse_pads",
    "parse_pattern_status",
    "parse_pattern_total",
    "parse_pong",
    "parse_push_event",
    "parse_read",
    "parse_response",
    "parse_rstinfo",
    "parse_safety",
    "parse_state",
    "parse_sync_count",
    "parse_ts_event_line",
    "parse_ts_get_header",
    "parse_ts_status",
    "parse_version",
    "pattern_add_commands",
    "pattern_run_command",
    "ping_command",
    "ts_arm_command",
    "ts_get_command",
    "usbsafe_command",
    "wdog_command",
    "write_command",
]
