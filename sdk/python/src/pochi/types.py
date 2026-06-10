"""Core types shared across the SDK. Mirrors the Rust reference
implementation (``sdk/rust/src/types.rs``). ``dataclasses.asdict`` yields
the snake_case wire format directly (docs/sdk-api-design.md §6)."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


@dataclass
class DeviceInfo:
    uid: str
    device_number: int | None
    port: str
    version: str | None


@dataclass
class VersionInfo:
    major: int
    minor: int
    patch: int
    protocol_version: int


@dataclass
class Capabilities:
    protocol_version: int
    max_dio: int
    out_count: int
    in_count: int
    ts_resolution_ns: int
    max_pattern_steps: int
    ts_ring_events: int
    features: int

    def has_sync(self) -> bool:
        """True if bit 0 of ``features`` (sync capability) is set."""
        return (self.features & 0x01) != 0


@dataclass
class IoState:
    inputs: int
    outputs: int
    flags: int


class PullMode(str, Enum):
    NONE = "none"
    UP = "up"
    DOWN = "down"


@dataclass
class PinMap:
    version: int
    out_base: int
    out_count: int
    in_base: int
    in_count: int
    pull: PullMode
    flags: int


@dataclass
class PatternStep:
    out_bits: int
    hold_us: int


class PatternMode(str, Enum):
    ONCE = "once"
    LOOP = "loop"


class PatternState(str, Enum):
    IDLE = "idle"
    #: Pattern data loaded but not started (FW state 1).
    LOADED = "loaded"
    RUNNING = "running"
    DONE = "done"


@dataclass
class PatternStatus:
    state: PatternState
    current_step: int
    loops_done: int


class EdgeMode(str, Enum):
    RISING = "rising"
    FALLING = "falling"
    BOTH = "both"


@dataclass
class TimestampEvent:
    inputs: int
    raw_count: int
    raw_phase: int
    sync_active: bool
    #: Host-computed: raw_count * 1000 + raw_phase * 40 (uncorrected).
    timestamp_ns: int


@dataclass
class TimestampResult:
    events: list[TimestampEvent] = field(default_factory=list)
    reconciled: bool = False


class SyncRole(str, Enum):
    MASTER = "master"
    SLAVE = "slave"


class SyncState(str, Enum):
    IDLE = "idle"
    ARMED = "armed"
    MASTER_ARMED = "master_armed"
    CLOCKING = "clocking"


# --- push events ---


@dataclass
class InputChangeEvent:
    inputs: int
    timestamp_us: int


@dataclass
class PatternDoneEvent:
    loops: int


@dataclass
class SyncDoneEvent:
    status: str
    devnum: int
    timestamp: int


@dataclass
class UnknownEvent:
    """Unrecognized or malformed push line, preserved verbatim so newer
    firmware events are observable instead of silently dropped."""

    raw: str


PushEvent = InputChangeEvent | PatternDoneEvent | SyncDoneEvent | UnknownEvent
