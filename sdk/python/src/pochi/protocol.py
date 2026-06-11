"""Command builders and typed response parsers for the CDC text protocol.
Pure functions (no I/O) — every parser is unit-testable without a device.
Mirrors ``sdk/rust/src/protocol.rs``."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .errors import ParseError, SdkError, UnsupportedFirmwareError, from_error_code
from .reconcile import as_is_ns
from .types import (
    Capabilities,
    EdgeMode,
    InputChangeEvent,
    IoState,
    PatternDoneEvent,
    PatternMode,
    PatternState,
    PatternStatus,
    PatternStep,
    PinMap,
    PullMode,
    PushEvent,
    SyncDoneEvent,
    TimestampEvent,
    UnknownEvent,
    VersionInfo,
)


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
    """Extract ``count=N`` from an OK data string (ts get / sync count)."""
    for part in ok_data.split():
        if part.startswith("count="):
            value = part[6:]
            if not value.isdigit():
                raise ParseError(f"invalid count= value: {ok_data}")
            return int(value)
    raise ParseError(f"missing count= field: {ok_data}")


def parse_count_overflow_field(ok_data: str) -> tuple[int, bool]:
    """Extract ``count=N overflow=B`` from a ``ts get`` OK data string.

    ``overflow=B`` was added in FW v0.1.2 (Pochi-DIO
    ``fix/cdc-tx-buffer-truncation``) and signals that the ring buffer
    overflowed since the last ``ts get`` (read-then-clear on the FW side).
    A missing ``overflow=`` (older FW) is treated as ``overflow=0``.
    """
    count = parse_count_field(ok_data)
    for part in ok_data.split():
        if part.startswith("overflow="):
            value = part[len("overflow=") :]
            if value == "0":
                return count, False
            if value == "1":
                return count, True
            raise ParseError(f"invalid overflow= value: {value}")
    return count, False


def _parse_u32(s: str) -> int:
    if re.fullmatch(r"0[xX][0-9a-fA-F]+", s):
        value = int(s, 16)
    elif s.isdigit():
        value = int(s)
    else:
        raise ParseError(f"invalid number: {s}")
    if value > 0xFFFFFFFF:
        raise ParseError(f"invalid number: {s}")
    return value


def _fields(data: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in data.split():
        key, sep, value = part.partition("=")
        if sep and key:
            out[key] = value
    return out


def _require(fields: dict[str, str], key: str, ctx: str) -> str:
    if key not in fields:
        raise ParseError(f"missing {key}= field in {ctx}")
    return fields[key]


def _int_strict(s: str, ctx: str) -> int:
    if not s.isdigit():
        raise ParseError(f"invalid number in {ctx}: {s}")
    return int(s)


# --- version ---


def parse_version(data: str) -> VersionInfo:
    """Parse ``v0.1.0 proto=1``."""
    match = None
    for part in data.split():
        if re.fullmatch(r"v\d+\.\d+\.\d+", part):
            match = part
            break
    if match is None:
        raise ParseError(f"missing version in: {data}")
    major, minor, patch = (int(x) for x in match[1:].split("."))
    fields = _fields(data)
    if "proto" not in fields:
        raise ParseError(f"missing proto= in: {data}")
    return VersionInfo(
        major=major,
        minor=minor,
        patch=patch,
        protocol_version=_int_strict(fields["proto"], "version"),
    )


# --- caps ---


def parse_caps(data: str) -> Capabilities:
    """Parse ``dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256
    feat=0x...``. Old firmware (``ts_res=1000``) fails loudly."""
    f = _fields(data)
    ctx = f"caps: {data}"
    ts_res = _int_strict(_require(f, "ts_res", ctx).removesuffix("ns"), ctx)
    caps = Capabilities(
        protocol_version=0,  # populated by the caller from `version`
        max_dio=_int_strict(_require(f, "dio", ctx), ctx),
        out_count=_int_strict(_require(f, "out", ctx), ctx),
        in_count=_int_strict(_require(f, "in", ctx), ctx),
        ts_resolution_ns=ts_res,
        max_pattern_steps=_int_strict(_require(f, "pattern", ctx), ctx),
        ts_ring_events=_int_strict(_require(f, "ring", ctx), ctx),
        features=_parse_u32(_require(f, "feat", ctx)),
    )
    if caps.ts_resolution_ns == 1000:
        raise UnsupportedFirmwareError(
            "caps reports ts_res=1000ns (pre-Phase 9.6 timestamp format)"
        )
    return caps


# --- info ---


def parse_info(data: str) -> tuple[str, int | None]:
    """Parse ``uid=AABBCCDD11223344 devnum=42``. devnum 255 maps to None."""
    f = _fields(data)
    uid = f.get("uid", "")
    if not uid:
        raise ParseError(f"missing uid in info response: {data}")
    device_number: int | None = None
    if "devnum" in f:
        n = _int_strict(f["devnum"], f"info: {data}")
        device_number = None if n == 255 else n
    return uid, device_number


# --- map ---


def parse_map(data: str) -> PinMap:
    """Parse ``v=1 out=0:12 in=12:11 pull=up flags=0x01``."""
    f = _fields(data)
    ctx = f"map: {data}"

    def parse_range(key: str) -> tuple[int, int]:
        value = _require(f, key, ctx)
        base, sep, count = value.partition(":")
        if not sep:
            raise ParseError(f"invalid {key}= range in {ctx}")
        return _int_strict(base, ctx), _int_strict(count, ctx)

    out_base, out_count = parse_range("out")
    in_base, in_count = parse_range("in")
    pull = _require(f, "pull", ctx)
    if pull not in ("none", "up", "down"):
        raise ParseError(f"invalid pull mode in map: {pull}")
    return PinMap(
        version=_int_strict(_require(f, "v", ctx), ctx),
        out_base=out_base,
        out_count=out_count,
        in_base=in_base,
        in_count=in_count,
        pull=PullMode(pull),
        flags=_parse_u32(_require(f, "flags", ctx)),
    )


def map_to_hex(pin_map: PinMap) -> str:
    """Encode a PinMap as the 48-char hex string for ``map set``.
    Extended fields not in PinMap (out_default, polarities) are zero."""
    buf = bytearray(24)
    buf[0] = pin_map.version
    buf[1] = pin_map.out_base
    buf[2] = pin_map.out_count
    buf[3] = pin_map.in_base
    buf[4] = pin_map.in_count
    buf[5] = {"none": 0, "up": 1, "down": 2}[pin_map.pull.value]
    buf[6] = pin_map.flags
    return buf.hex()


# --- read / write / state ---


def parse_read(data: str) -> int:
    """Parse the ``read`` response data: ``0x000005``."""
    return _parse_u32(data.strip())


def parse_state(data: str) -> IoState:
    """Parse ``in=0x000005 out=0x00000A flags=0x00``."""
    f = _fields(data)
    ctx = f"state: {data}"
    return IoState(
        inputs=_parse_u32(_require(f, "in", ctx)),
        outputs=_parse_u32(_require(f, "out", ctx)),
        flags=_parse_u32(_require(f, "flags", ctx)),
    )


# --- pattern ---


def pattern_to_hex(steps: list[PatternStep]) -> str:
    """Encode pattern steps for ``pattern load``: step count (u16 LE)
    followed by 8 bytes per step (out_bits u32 LE + hold_us u32 LE)."""
    if not steps:
        raise ParseError("pattern must have at least one step")
    if len(steps) > 0xFFFF:
        raise ParseError(f"too many pattern steps: {len(steps)}")
    data = bytearray(len(steps).to_bytes(2, "little"))
    for step in steps:
        data += step.out_bits.to_bytes(4, "little")
        data += step.hold_us.to_bytes(4, "little")
    return data.hex()


def parse_accepted(data: str) -> int:
    """Parse ``accepted=4`` from the ``pattern load`` response."""
    for part in data.split():
        if part.startswith("accepted="):
            return _int_strict(part[9:], f"accepted: {data}")
    raise ParseError(f"missing accepted= field: {data}")


def pattern_run_command(mode: PatternMode, repeat: int) -> str:
    """Build the ``pattern run`` command string."""
    if mode is PatternMode.ONCE:
        return "pattern run once 1"
    return f"pattern run loop {repeat}"


def parse_pattern_status(data: str) -> PatternStatus:
    """Parse ``state=running step=5 loops=3``."""
    f = _fields(data)
    ctx = f"pattern status: {data}"
    state = _require(f, "state", ctx)
    if state not in ("idle", "loaded", "running", "done"):
        raise ParseError(f"unknown pattern state: {state}")
    return PatternStatus(
        state=PatternState(state),
        current_step=_int_strict(_require(f, "step", ctx), ctx),
        loops_done=_int_strict(_require(f, "loops", ctx), ctx),
    )


# --- timestamp ---


def ts_arm_command(mask: int, mode: EdgeMode) -> str:
    """Build the ``ts arm`` command string."""
    return f"ts arm {mask:#x} {mode.value}"


def parse_ts_event_line(line: str) -> TimestampEvent:
    """Parse one ``ts get`` event line (FW Phase 9.6):
    ``0x00000005 c=1000 p=7 s=1``. The pre-9.6 ``t=`` format is rejected
    as UnsupportedFirmwareError — never parsed silently."""
    trimmed = line.strip()
    f = _fields(trimmed)
    inputs_part = next((p for p in trimmed.split() if p.startswith(("0x", "0X"))), None)

    if "t" in f and "c" not in f:
        raise UnsupportedFirmwareError(
            f"ts event uses pre-Phase 9.6 `t=` format: {trimmed}"
        )
    if inputs_part is None:
        raise ParseError(f"missing inputs (0x...) field in ts event: {trimmed}")
    ctx = f"ts event: {trimmed}"
    raw_count = _int_strict(_require(f, "c", ctx), ctx)
    raw_phase = _int_strict(_require(f, "p", ctx), ctx)
    s = _require(f, "s", ctx)
    if s not in ("0", "1"):
        raise ParseError(f"invalid s= in ts event: {s}")
    return TimestampEvent(
        inputs=_parse_u32(inputs_part),
        raw_count=raw_count,
        raw_phase=raw_phase,
        sync_active=s == "1",
        timestamp_ns=as_is_ns(raw_count, raw_phase),
    )


# --- sync ---


def parse_sync_count(data: str) -> int:
    """Parse the ``sync count`` response data: ``count=1000000``."""
    return parse_count_field(data)


# --- push events ---


def parse_push_event(payload: str) -> PushEvent:
    """Parse the payload of a push line (after ``! ``). Unknown event
    types are preserved as UnknownEvent rather than dropped."""
    trimmed = payload.strip()
    kind, _, rest = trimmed.partition(" ")
    f = _fields(rest)

    if kind == "INPUT":
        inputs_part = next(
            (p for p in rest.split() if p.startswith(("0x", "0X"))), None
        )
        if inputs_part is None:
            raise ParseError(f"missing inputs (0x...) in INPUT event: {trimmed}")
        t = f.get("t")
        if t is None or not t.isdigit():
            raise ParseError(f"missing or invalid t= in INPUT event: {trimmed}")
        return InputChangeEvent(inputs=_parse_u32(inputs_part), timestamp_us=int(t))
    if kind == "PATTERN_DONE":
        loops = f.get("loops")
        if loops is None or not loops.isdigit():
            raise ParseError(
                f"missing or invalid loops= in PATTERN_DONE event: {trimmed}"
            )
        return PatternDoneEvent(loops=int(loops))
    if kind == "SYNC_DONE":
        status = f.get("status")
        devnum = f.get("devnum")
        ts = f.get("ts")
        if (
            status is None
            or devnum is None
            or not devnum.isdigit()
            or ts is None
            or not ts.isdigit()
        ):
            raise ParseError(f"missing field in SYNC_DONE event: {trimmed}")
        return SyncDoneEvent(status=status, devnum=int(devnum), timestamp=int(ts))
    return UnknownEvent(raw=trimmed)


__all__ = [
    "Response",
    "parse_response",
    "parse_count_field",
    "parse_count_overflow_field",
    "parse_version",
    "parse_caps",
    "parse_info",
    "parse_map",
    "map_to_hex",
    "parse_read",
    "parse_state",
    "pattern_to_hex",
    "parse_accepted",
    "pattern_run_command",
    "parse_pattern_status",
    "ts_arm_command",
    "parse_ts_event_line",
    "parse_sync_count",
    "parse_push_event",
    "SdkError",
]
