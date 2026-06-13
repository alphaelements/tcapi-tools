"""Typed SDK errors. Mirrors ``sdk/rust/src/error.rs``; every device error
code and SDK-level condition has a distinct, catchable exception class."""

from __future__ import annotations


class SdkError(Exception):
    """Base class for all SDK errors."""

    code: str = "SDK_ERROR"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


# --- device errors (from ERR responses) ---


class BadCommandError(SdkError):
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


class SyncTimeoutError(SdkError):
    code = "SYNC_TIMEOUT"


class NoResourceError(SdkError):
    code = "NO_RESOURCE"


class NotRunningError(SdkError):
    code = "NOT_RUNNING"


class UnknownDeviceError(SdkError):
    code = "UNKNOWN_DEVICE"


# --- SDK errors ---


class ConnectionError_(SdkError):  # trailing _ avoids shadowing builtins
    code = "CONNECTION"


class IoError(SdkError):
    code = "IO"


class ParseError(SdkError):
    code = "PARSE"


class TimeoutError_(SdkError):
    code = "TIMEOUT"


class NoDeviceError(SdkError):
    code = "NO_DEVICE"


class MultipleDevicesError(SdkError):
    code = "MULTIPLE_DEVICES"


class DisconnectedError(SdkError):
    code = "DISCONNECTED"


class UnsupportedFirmwareError(SdkError):
    code = "UNSUPPORTED_FIRMWARE"

    def __init__(self, detail: str) -> None:
        super().__init__(f"unsupported firmware: {detail} (requires FW Phase 9.6+)")


_DEVICE_ERRORS: dict[str, tuple[type[SdkError], str]] = {
    "BAD_CMD": (BadCommandError, "unknown command"),
    "UNKNOWN_CMD": (BadCommandError, "unknown text command"),
    "BAD_PARAM": (BadParamError, "invalid parameter"),
    "BAD_MAP": (BadMapError, "map validation failed"),
    "BUSY": (BusyError, "device is busy"),
    "FLASH": (FlashError, "flash write/read failed"),
    "TOO_LONG": (TooLongError, "payload too long"),
    "LINE_TOO_LONG": (TooLongError, "command line exceeds 128 bytes"),
    "NOT_ARMED": (NotArmedError, "timestamp not armed"),
    "SYNC_STATE": (SyncStateError, "invalid sync state transition"),
    "SYNC_TIMEOUT": (SyncTimeoutError, "sync pulse not detected"),
    "NO_RESOURCE": (NoResourceError, "required resource not configured"),
    "NOT_RUNNING": (NotRunningError, "pattern not running"),
}


def from_error_code(code: str) -> SdkError:
    """Map an ``ERR <code>`` response to a typed error."""
    entry = _DEVICE_ERRORS.get(code)
    if entry is not None:
        cls, hint = entry
        return cls(f"device error: {code} ({hint})")
    return UnknownDeviceError(f"device error: {code}")
