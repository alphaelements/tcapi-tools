"""Typed SDK errors. Mirrors ``sdk/rust/src/error.rs``; every device error
name the text protocol can answer and every SDK-level condition has a
distinct, catchable exception class (docs/sdk-api-design.md section 4)."""

from __future__ import annotations

import re


class SdkError(Exception):
    """Base class for all SDK errors."""

    code: str = "SDK_ERROR"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


# --- device errors (from ERR responses) ---


class BadCommandError(SdkError):
    """``ERR BAD_CMD``: binary / HID transports only; a text device never
    answers it."""

    code = "BAD_CMD"


class BadParamError(SdkError):
    code = "BAD_PARAM"


class BadMapError(SdkError):
    code = "BAD_MAP"


class BusyError(SdkError):
    code = "BUSY"


class FlashError(SdkError):
    code = "FLASH"


class TooLongError(SdkError):
    code = "TOO_LONG"


class NotArmedError(SdkError):
    code = "NOT_ARMED"


class SyncStateError(SdkError):
    code = "SYNC_STATE"


class NoResourceError(SdkError):
    code = "NO_RESOURCE"


class NotRunningError(SdkError):
    code = "NOT_RUNNING"


class UnknownCmdError(SdkError):
    code = "UNKNOWN_CMD"


class LineTooLongError(SdkError):
    code = "LINE_TOO_LONG"


class FailsafeError(SdkError):
    """``ERR FAILSAFE``: the failsafe latch is set and the command would
    move an output away from its ``def``. Check ``safety``, then
    ``failsafe clear``."""

    code = "FAILSAFE"

    def __init__(self) -> None:
        super().__init__("device error: FAILSAFE (failsafe latch is set)")


class ExclusiveError(SdkError):
    """``ERR EXCLUSIVE group=<i> mask=0x%08x``: the instruction would put
    two or more pins of an exclusive group ON."""

    code = "EXCLUSIVE"

    def __init__(self, group: int, mask: int) -> None:
        super().__init__(
            f"device error: EXCLUSIVE (exclusive group {group} would be "
            f"violated, mask {mask:#010x})"
        )
        #: 0-based index of the first violating group.
        self.group = group
        #: The pin mask of that group.
        self.mask = mask


class TransportNotSupportedError(SdkError):
    """``ERR TRANSPORT_NOT_SUPPORTED``: HID only; a text device never
    answers it."""

    code = "TRANSPORT_NOT_SUPPORTED"


class UnknownDeviceError(SdkError):
    """Any other ``ERR <NAME>``; the raw name is preserved in the message."""

    code = "UNKNOWN_DEVICE"


# --- SDK errors ---


class ConnectionError_(SdkError):  # trailing _ avoids shadowing builtins
    code = "CONNECTION"


class IoError(SdkError):
    code = "IO"


class SafetyMismatchError(SdkError):
    """The ``safety`` / ``excl get`` read-back after ``apply_safety``
    differs from the applied settings; the message lists every
    difference."""

    code = "SAFETY_MISMATCH"

    def __init__(self, differences: str) -> None:
        super().__init__(
            f"safety read-back differs from the applied settings: {differences}"
        )


class ParseError(SdkError):
    """A response does not match the documented format (including unknown
    keys, missing keys and wrong counted-line counts)."""

    code = "PARSE"


class UnknownEventError(ParseError):
    """A push line whose event name the protocol does not define."""


class InvalidArgumentError(SdkError):
    """Rejected by host-side validation; nothing was sent."""

    code = "INVALID_ARGUMENT"


class TimeoutError_(SdkError):
    code = "TIMEOUT"


class NoDeviceError(SdkError):
    code = "NO_DEVICE"


class MultipleDevicesError(SdkError):
    code = "MULTIPLE_DEVICES"


class DisconnectedError(SdkError):
    """The device went away mid-session, or resynchronisation failed."""

    code = "DISCONNECTED"


class UnsupportedFirmwareError(SdkError):
    """``version`` reported a ``proto`` other than 2. Never parsed
    leniently."""

    code = "UNSUPPORTED_FIRMWARE"

    def __init__(self, detail: str) -> None:
        super().__init__(f"unsupported protocol: {detail}")


_DEVICE_ERRORS: dict[str, tuple[type[SdkError], str]] = {
    "BAD_CMD": (BadCommandError, "unknown command"),
    "BAD_PARAM": (BadParamError, "invalid parameter"),
    "BAD_MAP": (BadMapError, "map validation failed"),
    "BUSY": (BusyError, "device is busy"),
    "FLASH": (FlashError, "flash write/read failed"),
    "TOO_LONG": (TooLongError, "payload too long"),
    "NOT_ARMED": (NotArmedError, "timestamp not armed"),
    "SYNC_STATE": (SyncStateError, "invalid sync state transition"),
    "NO_RESOURCE": (NoResourceError, "required resource not configured"),
    "NOT_RUNNING": (NotRunningError, "pattern not running"),
    "UNKNOWN_CMD": (UnknownCmdError, "unknown command or subcommand"),
    "LINE_TOO_LONG": (LineTooLongError, "command line exceeds 256 bytes"),
    "TRANSPORT_NOT_SUPPORTED": (
        TransportNotSupportedError,
        "command not available on this transport",
    ),
}


_U32_MAX = 0xFFFFFFFF
_U8_MAX = 0xFF
_DEC = re.compile(r"[0-9]+")
_HEX = re.compile(r"0[xX][0-9a-fA-F]+")


def _exclusive(code: str, data: list[str]) -> SdkError:
    """``ERR EXCLUSIVE`` reads ``group=`` (decimal u8) and ``mask=``
    (decimal or ``0x`` hex u32) from its data tokens, in any order, ignoring
    other tokens. A line without both is a protocol violation: a
    :class:`ParseError`, never default values."""
    group: int | None = None
    mask: int | None = None
    for token in data:
        key, sep, value = token.partition("=")
        if not sep:
            continue
        if key == "group" and group is None:
            if _DEC.fullmatch(value) and int(value) <= _U8_MAX:
                group = int(value)
        elif key == "mask" and mask is None:
            if _HEX.fullmatch(value):
                number = int(value, 16)
            elif _DEC.fullmatch(value):
                number = int(value)
            else:
                continue
            if number <= _U32_MAX:
                mask = number
    if group is None or mask is None:
        return ParseError(
            f"malformed ERR EXCLUSIVE (expected group=<i> mask=0x%08x): ERR {code}"
        )
    return ExclusiveError(group, mask)


def from_error_code(code: str) -> SdkError:
    """Map the text after ``ERR `` to a typed error.

    The first whitespace-separated token is the error name; further
    ``key=value`` tokens are data and never make the line unparseable
    (protocol-reference.md section 3). ``EXCLUSIVE`` reads its ``group=`` and
    ``mask=`` data; for other known names the data tokens are ignored. A name
    the protocol does not define is preserved verbatim, with the whole text
    (``UnknownDeviceError``), never mapped to a default."""
    tokens = code.split()
    name = tokens[0] if tokens else ""
    if name == "FAILSAFE":
        return FailsafeError()
    if name == "EXCLUSIVE":
        return _exclusive(code, tokens[1:])
    entry = _DEVICE_ERRORS.get(name)
    if entry is not None:
        cls, hint = entry
        return cls(f"device error: {name} ({hint})")
    return UnknownDeviceError(f"device error: {code}")
