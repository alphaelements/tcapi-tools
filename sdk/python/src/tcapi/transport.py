"""Serial transport: line-oriented command/response exchange with push
event multiplexing (R-H1 to R-H3). Mirrors ``sdk/rust/src/transport.rs``.

A background reader thread owns the read half of the port. It splits the
byte stream into lines and routes them: push lines (``! ...``) go to the
event callback, everything else goes to the response queue, so a push
event arriving mid-command never corrupts response parsing.

Contract (docs/sdk-api-design.md "Transport Contract"):

- **One command, one response.** A response is a single ``OK ...`` /
  ``ERR <NAME>`` line, or an ``OK`` header carrying ``count=<N>`` followed
  by exactly N continuation lines. There is no drain-and-discard of "extra"
  lines.
- **Resynchronisation.** A timeout, an unparseable line or a short counted
  response marks the connection *desynced*. The next operation first sends
  ``ping <random u32>`` and discards every response line until
  ``OK pong=<same value>`` arrives (push events keep flowing to the event
  path meanwhile). If that fails the connection is closed.
- **DTR** is asserted when the port is opened; the device sends no events
  without it.
- **Events.** An unknown or malformed event line is logged as an error and
  discarded; it is never delivered and never queued as a response.
"""

from __future__ import annotations

import logging
import queue
import secrets
import threading
import time
from collections.abc import Callable
from typing import Protocol

import serial

from .errors import (
    DisconnectedError,
    InvalidArgumentError,
    IoError,
    ParseError,
    TimeoutError_,
    UnknownEventError,
)
from .protocol import (
    Response,
    parse_count_field,
    parse_pong,
    parse_push_event,
    parse_response,
)
from .types import PushEvent

logger = logging.getLogger("tcapi")

#: Conventional baud rate. Irrelevant for USB CDC but required by the API.
BAUD_RATE = 115_200

#: Default time to wait for a command response (seconds).
DEFAULT_COMMAND_TIMEOUT = 2.0

#: Poll interval of the reader thread (also bounds shutdown latency).
_READ_POLL_INTERVAL = 0.05

#: Longest device line the reader will accumulate. The longest legitimate
#: line (``help`` / ``ts get`` continuation) is far below this; a stream
#: with no newline for this many bytes is a fault, not a line.
MAX_DEVICE_LINE_BYTES = 4096

#: Continuation lines of a counted response start with two spaces.
_CONTINUATION_PREFIX = "  "

EventCallback = Callable[[PushEvent], None]


def _reject_line_breaks(cmd: str) -> None:
    """A command is exactly one wire line: an embedded CR/LF would make the
    device answer several commands while the host reads one response."""
    if "\r" in cmd or "\n" in cmd:
        raise InvalidArgumentError("command must not contain CR/LF")


class PortLike(Protocol):
    """Minimal duplex-port surface the transport needs. Satisfied by
    ``serial.Serial`` and the in-memory fake used in tests."""

    timeout: float | None

    def read(self, size: int = 1) -> bytes: ...

    def write(self, data: bytes) -> int | None: ...

    def close(self) -> None: ...


class Transport:
    """Line-oriented transport to one device. Commands are serialised: one
    exchange (including a preceding resynchronisation) at a time."""

    def __init__(self, port: PortLike) -> None:
        port.timeout = _READ_POLL_INTERVAL
        self._port = port
        self._responses: queue.Queue[str] = queue.Queue()
        self._event_callback: EventCallback | None = None
        self._event_lock = threading.Lock()
        self._command_lock = threading.RLock()
        self._shutdown = threading.Event()
        self._disconnected = threading.Event()
        self._desynced = False
        self.timeout = DEFAULT_COMMAND_TIMEOUT
        self._reader = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader.start()

    @classmethod
    def open(cls, path: str) -> Transport:
        """Open the serial port at ``path``, assert DTR and start the
        reader thread."""
        try:
            port = serial.Serial(path, BAUD_RATE, timeout=_READ_POLL_INTERVAL)
            port.dtr = True
        except (serial.SerialException, OSError) as exc:
            raise IoError(f"failed to open serial port {path}: {exc}") from exc
        return cls(port)

    @property
    def desynced(self) -> bool:
        """True while the next operation must resynchronise first."""
        return self._desynced

    def set_event_callback(self, callback: EventCallback | None) -> None:
        """Install a push event subscriber (replaces any previous one).
        Push events arriving with no subscriber installed are discarded.
        The callback runs on the reader thread — keep it short."""
        with self._event_lock:
            self._event_callback = callback

    # --- command paths ---

    def command(self, cmd: str) -> str:
        """Send a command expecting a single OK/ERR response line; returns
        the data after ``OK``. A counted response to it is an error."""
        data, lines = self._exchange(cmd)
        if lines is not None:
            raise ParseError(
                f"{cmd!r} was answered with a counted response ({data}); "
                "use command_counted()"
            )
        return data

    def command_counted(self, cmd: str) -> tuple[str, list[str]]:
        """Send a command whose response is ``OK count=N ...`` followed by
        exactly N continuation lines (``ts get``, ``help``). Returns the
        header data and the continuation lines (with their two leading
        spaces).

        Each continuation line gets its own ``self.timeout`` budget: large
        captures stream many lines and the USB CDC scheduler may pace them
        slower than a single command-level timeout allows."""
        data, lines = self._exchange(cmd)
        if lines is None:
            raise ParseError(
                f"{cmd!r} was answered without a count= header, expected a "
                f"counted response: {data}"
            )
        return data, lines

    def raw_exchange(self, cmd: str) -> list[str]:
        """Send an arbitrary command and return **every** wire line of the
        response: the ``OK`` / ``ERR`` header and, for a counted response,
        its N continuation lines. A device error is returned as its
        ``ERR <NAME>`` line, not raised. No host-side limits are applied
        here (see ``Connection.raw``)."""
        _reject_line_breaks(cmd)
        with self._command_lock:
            self._prepare()
            self._write_line(cmd)
            header = self._read_line()
            response = self._classify(header)
            if response.kind == "err":
                return [header]
            lines = self._read_continuation(response.ok_data())
            return [header, *(lines or [])]

    def close(self) -> None:
        """Stop the reader thread and close the port."""
        self._shutdown.set()
        self._reader.join(timeout=2.0)
        try:
            self._port.close()
        except Exception as exc:  # port may already be gone
            raise IoError(f"failed to close port: {exc}") from exc

    def __enter__(self) -> Transport:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # --- internals: one exchange ---

    def _exchange(self, cmd: str) -> tuple[str, list[str] | None]:
        """One command / one response. Returns the ``OK`` data and the
        continuation lines (``None`` when the header has no ``count=``)."""
        _reject_line_breaks(cmd)
        with self._command_lock:
            self._prepare()
            self._write_line(cmd)
            header = self._read_line()
            data = self._classify(header).ok_data()
            return data, self._read_continuation(data)

    def _classify(self, line: str) -> Response:
        """Parse a response header; an unparseable line desyncs."""
        try:
            return parse_response(line)
        except ParseError:
            self._desynced = True
            raise

    def _read_continuation(self, data: str) -> list[str] | None:
        if not any(part.startswith("count=") for part in data.split()):
            return None
        try:
            count = parse_count_field(data)
        except ParseError:
            self._desynced = True
            raise
        lines: list[str] = []
        for _ in range(count):
            line = self._read_line()
            if not line.startswith(_CONTINUATION_PREFIX):
                self._desynced = True
                raise ParseError(
                    f"expected a continuation line (two leading spaces), got: {line!r}"
                )
            lines.append(line)
        return lines

    def _prepare(self) -> None:
        """Before every operation: refuse on a dead connection, and
        resynchronise first when the stream is out of step (R-H2)."""
        if self._disconnected.is_set():
            raise DisconnectedError("device disconnected")
        if self._desynced:
            self._resync()

    def _resync(self) -> None:
        """Send ``ping <random u32>`` and discard response lines until
        ``OK pong=<same value>``. On failure the connection is closed."""
        value = secrets.randbits(32)
        # One budget for the whole resync: a device that keeps emitting stale
        # lines but never the matching pong must not hold the caller forever.
        deadline = time.monotonic() + max(self.timeout, 0.0)
        try:
            self._write_line(f"ping {value}")
            while True:
                line = self._read_line(deadline)
                try:
                    response = parse_response(line)
                    if response.kind == "ok" and parse_pong(response.data) == value:
                        break
                except ParseError:
                    pass  # a stale line: exactly what resync discards
        except (TimeoutError_, DisconnectedError, IoError) as exc:
            self._fail(f"resynchronisation failed ({exc.message})", exc)
        self._desynced = False

    def _fail(self, reason: str, cause: Exception) -> None:
        """Close the connection after an unrecoverable stream error."""
        self._disconnected.set()
        self._shutdown.set()
        try:
            self._port.close()
        except Exception as exc:
            raise DisconnectedError(
                f"{reason}; closing the port failed: {exc}"
            ) from cause
        raise DisconnectedError(f"{reason}; connection closed") from cause

    def _write_line(self, cmd: str) -> None:
        _reject_line_breaks(cmd)
        if self._disconnected.is_set():
            raise DisconnectedError("device disconnected")
        try:
            self._port.write(f"{cmd}\r\n".encode())
        except Exception as exc:
            # A write failure usually means the device is gone; give the
            # reader thread a moment to confirm so the error is uniform.
            if self._disconnected.wait(timeout=0.3):
                raise DisconnectedError("device disconnected") from exc
            raise IoError(f"write failed: {exc}") from exc

    def _read_line(self, deadline: float | None = None) -> str:
        """Next response-queue line, by ``deadline`` (monotonic seconds;
        default: ``self.timeout`` from now). A timeout desyncs the
        stream."""
        if deadline is None:
            deadline = time.monotonic() + max(self.timeout, 0.0)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if self._disconnected.is_set():
                    raise DisconnectedError("device disconnected")
                self._desynced = True
                raise TimeoutError_("timeout waiting for response")
            try:
                # Wake periodically so a disconnect surfaces promptly
                # instead of after the full command timeout.
                return self._responses.get(timeout=min(remaining, 0.05))
            except queue.Empty:
                if self._disconnected.is_set() and self._responses.empty():
                    raise DisconnectedError("device disconnected") from None

    # --- internals: reader thread ---

    def _reader_loop(self) -> None:
        acc = bytearray()
        skipping = False  # inside a runaway line: drop bytes up to its newline
        while not self._shutdown.is_set():
            try:
                chunk = self._port.read(256)
            except Exception:
                break  # fatal I/O error: device gone
            if chunk is None:
                continue
            if chunk == b"" and getattr(self._port, "closed", False):
                break
            acc += chunk
            while (idx := acc.find(b"\n")) >= 0:
                raw_line = bytes(acc[: idx + 1])
                del acc[: idx + 1]
                if skipping:
                    skipping = False
                    continue
                line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line:
                    continue
                if line.startswith("! "):
                    self._dispatch_event(line[2:])
                else:
                    self._responses.put(line)
            if len(acc) > MAX_DEVICE_LINE_BYTES:
                logger.error(
                    "device line too long (over %d bytes without a newline); "
                    "discarding it",
                    MAX_DEVICE_LINE_BYTES,
                )
                acc.clear()
                skipping = True
                self._desynced = True
        self._disconnected.set()

    def _dispatch_event(self, payload: str) -> None:
        with self._event_lock:
            callback = self._event_callback
        try:
            event = parse_push_event(payload)
        except UnknownEventError:
            logger.error("discarding unknown event line: ! %s", payload)
            return
        except ParseError as exc:
            logger.error(
                "discarding malformed event line: ! %s (%s)", payload, exc.message
            )
            return
        if callback is None:
            return
        try:
            callback(event)
        except Exception:
            logger.exception("event callback raised; event %r dropped", event)
