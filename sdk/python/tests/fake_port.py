"""In-memory duplex port for transport / connection tests.

The device side lives in :mod:`tests.golden` (``ReplayPort``): every device
response in this suite comes from the golden transcripts (R-C4). This module
only moves bytes."""

from __future__ import annotations

import queue
import threading
from collections.abc import Callable


class FakePort:
    """Duplex in-memory port satisfying ``tcapi.transport.PortLike``.
    ``read`` blocks with the configured timeout; ``feed`` injects
    device -> host lines; written host -> device lines invoke
    ``on_command``."""

    def __init__(self) -> None:
        self.timeout: float | None = 0.05
        self.closed = False
        self.written: list[str] = []
        self.on_command: Callable[[str], None] | None = None
        self._rx: queue.Queue[bytes] = queue.Queue()
        self._write_acc = ""
        self._lock = threading.Lock()

    def read(self, size: int = 1) -> bytes:
        if self.closed:
            raise OSError("port closed")
        try:
            return self._rx.get(timeout=self.timeout or 0.05)
        except queue.Empty:
            return b""

    def write(self, data: bytes) -> int:
        if self.closed:
            raise OSError("port closed")
        with self._lock:
            self._write_acc += data.decode()
            while "\n" in self._write_acc:
                line, _, self._write_acc = self._write_acc.partition("\n")
                line = line.rstrip("\r")
                self.written.append(line)
                if self.on_command is not None:
                    self.on_command(line)
        return len(data)

    def close(self) -> None:
        self.closed = True
        self._rx.put(b"")  # wake a blocked reader so shutdown is immediate

    def feed(self, *lines: str) -> None:
        """Simulate device -> host lines."""
        for line in lines:
            self._rx.put(f"{line}\r\n".encode())

    def feed_raw(self, data: str) -> None:
        """Simulate device -> host raw bytes (no line ending added)."""
        self._rx.put(data.encode())
