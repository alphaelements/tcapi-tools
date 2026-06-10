"""In-memory fake port + mock firmware for transport/E2E tests.
Mirrors the Rust PTY MockFw (`sdk/rust/tests/pty_e2e.rs`)."""

from __future__ import annotations

import queue
import threading
from collections.abc import Callable


class FakePort:
    """Duplex in-memory port satisfying ``pochi.transport.PortLike``.
    ``read`` blocks with the configured timeout; ``feed`` injects
    device → host lines; written host → device lines invoke
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

    def feed(self, *lines: str) -> None:
        """Simulate device → host lines."""
        for line in lines:
            self._rx.put(f"{line}\r\n".encode())

    def feed_raw(self, data: str) -> None:
        """Simulate device → host raw bytes (no line ending added)."""
        self._rx.put(data.encode())


class MockFw:
    """Stateful mock firmware implementing the FW Phase 9.6 command set."""

    def __init__(self) -> None:
        self.outputs = 0
        self.inputs = 0x05
        self.map = "v=1 out=0:12 in=12:11 pull=up flags=0x01"
        self.pattern_loaded = 0
        self.pattern_state = "idle"
        self.ts_armed = False
        self.ts_events = [
            "  0x00000005 c=1000 p=7 s=1",
            "  0x0000000A c=2000 p=12 s=0",
        ]
        self.sync_clocking = False
        self.old_firmware = False

    def handle(self, cmd: str) -> list[str]:
        parts = cmd.strip().lower().split()
        key = " ".join(parts)
        if key == "version":
            return ["OK v0.1.0 proto=1"]
        if key == "caps":
            ts_res = 1000 if self.old_firmware else 40
            return [
                f"OK dio=23 out=12 in=11 ts_res={ts_res}ns pattern=256 ring=256 "
                "feat=0x00000001"
            ]
        if key == "info":
            return ["OK uid=AABBCCDD11223344 devnum=42"]
        if parts and parts[0] == "devnum":
            return ["OK"]
        if key == "read":
            return [f"OK 0x{self.inputs:06X}"]
        if parts and parts[0] == "write":
            try:
                v = int(parts[1], 0)
                m = int(parts[2], 0)
            except (ValueError, IndexError):
                return ["ERR BAD_PARAM"]
            self.outputs = (self.outputs & ~m) | (v & m)
            return ["OK"]
        if key == "state":
            return [f"OK in=0x{self.inputs:06X} out=0x{self.outputs:06X} flags=0x00"]
        if key == "map get":
            return [f"OK {self.map}"]
        if parts[:2] == ["map", "set"]:
            hex_str = parts[2] if len(parts) > 2 else ""
            if len(hex_str) != 48:
                return ["ERR BAD_PARAM"]
            data = bytes.fromhex(hex_str)
            if data[2] != 0 and data[4] != 0 and data[3] < data[1] + data[2]:
                return ["ERR BAD_MAP"]
            pull = {0: "none", 1: "up", 2: "down"}.get(data[5], "down")
            self.map = (
                f"v={data[0]} out={data[1]}:{data[2]} in={data[3]}:{data[4]} "
                f"pull={pull} flags=0x{data[6]:02x}"
            )
            return ["OK"]
        if key == "map save":
            return ["OK"]
        if key == "map default":
            self.map = "v=1 out=0:0 in=0:23 pull=down flags=0x01"
            return ["OK"]
        if parts and parts[0] == "subscribe":
            return ["OK"]
        if parts[:2] == ["pattern", "load"]:
            try:
                data = bytes.fromhex(parts[2])
            except (ValueError, IndexError):
                return ["ERR BAD_PARAM"]
            if len(data) < 10:
                return ["ERR BAD_PARAM"]
            count = int.from_bytes(data[0:2], "little")
            if len(data) != 2 + count * 8:
                return ["ERR BAD_PARAM"]
            self.pattern_loaded = count
            self.pattern_state = "loaded"
            return [f"OK accepted={count}"]
        if parts[:2] == ["pattern", "run"]:
            if self.pattern_loaded == 0:
                return ["ERR BAD_PARAM"]
            if parts[2:4] == ["loop", "0"]:
                return ["ERR BAD_PARAM"]
            if self.pattern_state == "running":
                return ["ERR BUSY"]
            self.pattern_state = "running"
            return ["OK"]
        if key == "pattern stop":
            if self.pattern_loaded > 0:
                self.pattern_state = "loaded"
            return ["OK"]
        if key == "pattern status":
            return [f"OK state={self.pattern_state} step=0 loops=0"]
        if parts[:2] == ["ts", "arm"]:
            if self.ts_armed:
                return ["ERR BUSY"]
            self.ts_armed = True
            return ["OK"]
        if parts[:2] == ["ts", "get"]:
            if not self.ts_armed:
                return ["ERR NOT_ARMED"]
            if self.old_firmware:
                return ["OK count=1", "  0x00000005 t=1234567890"]
            max_events = int(parts[2]) if len(parts) > 2 else 0
            events = self.ts_events[:max_events]
            return [f"OK count={len(events)}", *events]
        if key == "ts disarm":
            self.ts_armed = False
            return ["OK"]
        if key in ("sync arm", "sync master", "sync disarm"):
            return ["OK"]
        if key == "sync start":
            self.sync_clocking = True
            return ["OK"]
        if key == "sync stop":
            self.sync_clocking = False
            return ["OK"]
        if key == "sync count":
            # `OK count=N` with NO data lines (unlike `ts get`).
            return ["OK count=1000000"] if self.sync_clocking else ["ERR SYNC_STATE"]
        return ["ERR UNKNOWN_CMD"]
