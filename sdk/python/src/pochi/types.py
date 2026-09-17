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


#: ``caps.features`` bit 0: multi-device clock sync (``SYNC_*`` commands).
FEAT_SYNC = 0x01

#: ``caps.features`` bit 1: reset commands (``PATTERN_RESET`` / ``SYSTEM_RESET``
#: / ``BOOTSEL_RESET``). Set by FW v0.1.3+.
FEAT_RESET = 0x02


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
        return (self.features & FEAT_SYNC) != 0

    def has_reset(self) -> bool:
        """True if the device supports ``PATTERN_RESET`` / ``SYSTEM_RESET`` /
        ``BOOTSEL_RESET`` (FW v0.1.3+)."""
        return (self.features & FEAT_RESET) != 0


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


#: Number of ``chN: OUT/IN`` detail lines following the ``OK v=2 ...``
#: header in a v2 ``map get`` response.
MAP_V2_CHANNEL_LINES = 25

#: Valid DIO pin bitmask for PinMapV2 (GP0-22, GP26, GP27).
VALID_DIO_MASK = 0x0C7FFFFF


def channel_to_gp(ch: int) -> int:
    """Map a PinMapV2 channel index (0-24) to its GPIO number.
    ch0-22 -> GP0-22 (1:1), ch23 -> GP26, ch24 -> GP27."""
    if ch <= 22:
        return ch
    if ch == 23:
        return 26
    if ch == 24:
        return 27
    raise ValueError(f"invalid PinMapV2 channel index: {ch}")


@dataclass
class PinMapV2:
    """25-channel bitmask pin map (FW unified-DIO v2). Text protocol
    responses only carry ``direction_mask`` (reconstructed from the
    ``chN: OUT/IN`` detail lines) — pull/polarity/edge/out_default are
    not observable over the text protocol and are intentionally absent
    here (see ``docs/plans`` v2 design doc §3 D2)."""

    version: int
    flags: int
    direction_mask: int
    out_count: int
    in_count: int
    channels: list[str]


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
    #: ``True`` if the FW reported a ring overflow since the last ``ts get``
    #: (i.e. events were dropped). ``False`` for FW without the ``overflow=``
    #: field in the ``ts get`` response.
    overflow: bool = False


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
class PatternTimeoutEvent:
    """Pattern aborted by the FW wall-clock safety budget (FW v0.1.3+). The
    SM / DMA are forced to a safe state; outputs hold the last written step
    value until the host issues SET_OUTPUTS or PATTERN_RESET."""

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


PushEvent = (
    InputChangeEvent | PatternDoneEvent | PatternTimeoutEvent | SyncDoneEvent | UnknownEvent
)
