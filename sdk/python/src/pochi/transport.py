"""Serial transport: line-oriented command/response exchange with push
event multiplexing. Mirrors ``sdk/rust/src/transport.rs``.

A background reader thread owns the read half of the port. It splits the
byte stream into lines and routes them: push lines (``! ...``) go to the
event callback, everything else goes to the response queue, so a push
event arriving mid-command never corrupts response parsing.

Two read disciplines exist and must stay separate:

- :meth:`Transport.command` — exactly one response line (OK/ERR).
- :meth:`Transport.command_counted` — ``OK count=N`` followed by exactly
  N data lines (only ``ts get``). Using a counted read on a single-line
  command (e.g. ``sync count``) would hang until timeout; using a plain
  read on ``ts get`` would leave N lines behind. Never unify them.
"""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable
from typing import Protocol

import serial

from .errors import DisconnectedError, IoError, TimeoutError_
from .protocol import parse_count_field, parse_push_event, parse_response
from .types import PushEvent, UnknownEvent

#: Conventional baud rate. Irrelevant for USB CDC but required by the API.
BAUD_RATE = 115_200

#: Default time to wait for a command response (seconds).
DEFAULT_COMMAND_TIMEOUT = 2.0

#: Poll interval of the reader thread (also bounds shutdown latency).
_READ_POLL_INTERVAL = 0.05

EventCallback = Callable[[PushEvent], None]


class PortLike(Protocol):
    """Minimal duplex-port surface the transport needs. Satisfied by
    ``serial.Serial`` and the in-memory fake used in tests."""

    timeout: float | None

    def read(self, size: int = 1) -> bytes: ...

    def write(self, data: bytes) -> int | None: ...

    def close(self) -> None: ...


class Transport:
    """Line-oriented transport to one device."""

    def __init__(self, port: PortLike) -> None:
        port.timeout = _READ_POLL_INTERVAL
        self._port = port
        self._responses: queue.Queue[str] = queue.Queue()
        self._event_callback: EventCallback | None = None
        self._event_lock = threading.Lock()
        self._shutdown = threading.Event()
        self._disconnected = threading.Event()
        self.timeout = DEFAULT_COMMAND_TIMEOUT
        self._reader = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader.start()

    @classmethod
    def open(cls, path: str) -> "Transport":
        """Open the serial port at ``path`` and start the reader thread."""
        try:
            port = serial.Serial(path, BAUD_RATE, timeout=_READ_POLL_INTERVAL)
        except serial.SerialException as exc:
            raise IoError(f"failed to open serial port {path}: {exc}") from exc
        return cls(port)

    def set_event_callback(self, callback: EventCallback | None) -> None:
        """Install a push event subscriber (replaces any previous one).
        Push events arriving with no subscriber installed are discarded.
        The callback runs on the reader thread — keep it short."""
        with self._event_lock:
            self._event_callback = callback

    def command(self, cmd: str) -> str:
        """Send a command expecting a single OK/ERR response line."""
        self._drain_stale_responses()
        self._write_line(cmd)
        line = self._recv_response(self.timeout)
        return parse_response(line).ok_data()

    def command_counted(self, cmd: str) -> tuple[str, list[str]]:
        """Send a command whose response is ``OK count=N`` followed by
        exactly N data lines (``ts get`` only).

        Each data line gets its own ``self.timeout`` budget: large captures
        stream many lines and the USB CDC scheduler may pace them slower
        than a single command-level timeout allows.
        """
        self._drain_stale_responses()
        self._write_line(cmd)

        first = self._recv_response(self.timeout)
        data = parse_response(first).ok_data()
        count = parse_count_field(data)

        lines = [self._recv_response(self.timeout) for _ in range(count)]
        return data, lines

    def command_fixed_lines(self, cmd: str, n: int) -> tuple[str, list[str]]:
        """Send a command whose OK response header is followed by exactly
        ``n`` additional data lines regardless of any count embedded in
        the header (``map get`` v2: 25 ``chN: OUT/IN`` detail lines).

        Unlike :meth:`command_counted`, ``n`` is supplied by the caller
        rather than parsed from the response — the v2 ``map get`` header
        carries ``out=``/``in=`` counts, not a line count.
        """
        self._drain_stale_responses()
        self._write_line(cmd)

        first = self._recv_response(self.timeout)
        data = parse_response(first).ok_data()

        lines = self.recv_lines(n)
        return data, lines

    def recv_lines(self, n: int) -> list[str]:
        """Read ``n`` more response-queue lines without sending anything.
        Used after :meth:`command` when the number of trailing detail
        lines can only be decided from the header just received (``map
        get`` v2's 25 ``chN: OUT/IN`` lines)."""
        return [self._recv_response(self.timeout) for _ in range(n)]

    def raw(self, cmd: str) -> str:
        """Send an arbitrary command and return the raw first response
        line (OK/ERR as received, unparsed). Stale extra lines are
        discarded before the next command."""
        self._drain_stale_responses()
        self._write_line(cmd)
        return self._recv_response(self.timeout)

    def close(self) -> None:
        """Stop the reader thread and close the port."""
        self._shutdown.set()
        self._reader.join(timeout=2.0)
        try:
            self._port.close()
        except Exception as exc:  # port may already be gone
            raise IoError(f"failed to close port: {exc}") from exc

    def __enter__(self) -> "Transport":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # --- internals ---

    def _write_line(self, cmd: str) -> None:
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

    def _recv_response(self, timeout: float) -> str:
        deadline = time.monotonic() + max(timeout, 0.0)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if self._disconnected.is_set():
                    raise DisconnectedError("device disconnected")
                raise TimeoutError_("timeout waiting for response")
            try:
                # Wake periodically so a disconnect surfaces promptly
                # instead of after the full command timeout.
                return self._responses.get(timeout=min(remaining, 0.05))
            except queue.Empty:
                if self._disconnected.is_set() and self._responses.empty():
                    raise DisconnectedError("device disconnected") from None

    def _drain_stale_responses(self) -> None:
        """Discard response lines left over from a previous timed-out or
        raw exchange so they cannot be mistaken for the next response."""
        while True:
            try:
                self._responses.get_nowait()
            except queue.Empty:
                return

    def _reader_loop(self) -> None:
        acc = bytearray()
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
                line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line:
                    continue
                if line.startswith("! "):
                    self._dispatch_event(line[2:])
                else:
                    self._responses.put(line)
        self._disconnected.set()

    def _dispatch_event(self, payload: str) -> None:
        with self._event_lock:
            callback = self._event_callback
        if callback is None:
            return
        # A malformed known-type event is delivered as UnknownEvent rather
        # than dropped: losing the line silently would hide FW mismatches.
        try:
            event: PushEvent = parse_push_event(payload)
        except Exception as exc:
            event = UnknownEvent(raw=f"{payload} (parse error: {exc})")
        callback(event)
