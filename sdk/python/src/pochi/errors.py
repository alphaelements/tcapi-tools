"""Typed SDK errors. Mirrors ``sdk/rust/src/error.rs``; every device error
name the text protocol can answer and every SDK-level condition has a
distinct, catchable exception class (docs/sdk-api-design.md section 4)."""

from __future__ import annotations


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


def from_error_code(code: str) -> SdkError:
    """Map an ``ERR <code>`` response to a typed error. A name the protocol
    does not define is preserved verbatim (``UnknownDeviceError``), never
    mapped to a default."""
    entry = _DEVICE_ERRORS.get(code)
    if entry is not None:
        cls, hint = entry
        return cls(f"device error: {code} ({hint})")
    return UnknownDeviceError(f"device error: {code}")
