"""v2 data types and the channel / pin convention (REF-V2 sections 2 and
4.2). Mirrors the Rust reference implementation (``sdk/rust/src/types.rs``).

Every bit mask on the wire is a **physical GP bit position**. Logical
channels ``ch0..ch24`` are a host-side display concept only; use
:func:`ch_to_gp`, :func:`gp_to_ch`, :func:`pin_label` and
:data:`VALID_DIO_MASK` instead of re-deriving bit positions.

``dataclasses.asdict`` yields the snake_case JSON form directly
(docs/sdk-api-design.md section 6); :meth:`Capabilities.to_json_dict`
renames the Python-keyword field ``in_`` to the wire key ``in``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any

from .errors import InvalidArgumentError

#: The only protocol version this SDK speaks (``version`` reports ``proto=2``).
PROTO_VERSION = 2

#: Bit mask of the DIO pins: GP0-GP22, GP26, GP27 (R-P2).
VALID_DIO_MASK = 0x0C7FFFFF

#: Number of DIO channels (``ch0..ch24``).
DIO_CHANNELS = 25

#: Pattern tick: one ``hold_ticks`` unit in nanoseconds.
PATTERN_TICK_NS = 200

#: First GP pin that is shifted past the unusable GP23-GP25 (ch23 -> GP26).
_FIRST_RELOCATED_GP = 26
#: First channel that is relocated (ch23).
_FIRST_RELOCATED_CH = 23
#: Highest GP number that is a DIO pin.
_LAST_DIO_GP = 27

_U32_MAX = 0xFFFFFFFF


def ch_to_gp(ch: int) -> int:
    """Physical GP pin of logical channel ``ch`` (ch0-22 -> GP0-22,
    ch23 -> GP26, ch24 -> GP27)."""
    if 0 <= ch < _FIRST_RELOCATED_CH:
        return ch
    if _FIRST_RELOCATED_CH <= ch < DIO_CHANNELS:
        return ch - _FIRST_RELOCATED_CH + _FIRST_RELOCATED_GP
    raise InvalidArgumentError(
        f"channel ch{ch} is out of range (ch0-ch{DIO_CHANNELS - 1})"
    )


def gp_to_ch(gp: int) -> int:
    """Logical channel of physical GP pin ``gp``; fails for non-DIO pins
    (GP23-GP25, GP28 and above)."""
    if 0 <= gp < _FIRST_RELOCATED_CH:
        return gp
    if _FIRST_RELOCATED_GP <= gp <= _LAST_DIO_GP:
        return gp - _FIRST_RELOCATED_GP + _FIRST_RELOCATED_CH
    raise InvalidArgumentError(f"GP{gp} is not a DIO pin")


def pin_label(gp: int) -> str:
    """Display label for physical GP pin ``gp``, e.g. ``GP26 (ch23)``."""
    return f"GP{gp} (ch{gp_to_ch(gp)})"


def check_dio_mask(name: str, mask: int) -> None:
    """Reject a mask that is not a u32 or has bits outside
    :data:`VALID_DIO_MASK` (R-PIN2)."""
    if mask < 0:
        raise InvalidArgumentError(f"{name} {mask} is negative")
    if mask & ~VALID_DIO_MASK:
        raise InvalidArgumentError(
            f"{name} {mask:#010x} has bits outside the DIO pins "
            f"({VALID_DIO_MASK:#010x})"
        )


@dataclass
class VersionInfo:
    major: int
    minor: int
    patch: int
    protocol_version: int

    @property
    def fw(self) -> str:
        """Firmware version as reported by ``version`` (``0.1.3``)."""
        return f"{self.major}.{self.minor}.{self.patch}"


#: ``caps.features`` bit 0: multi-device clock sync (``sync`` commands).
FEAT_SYNC = 0x01

#: ``caps.features`` bit 1: reset commands (``pattern reset`` / ``reset`` /
#: ``bootsel``). Set by FW v0.1.3+.
FEAT_RESET = 0x02


@dataclass
class Capabilities:
    """``caps`` response."""

    #: Number of DIO pins (25).
    dio: int
    #: Pins currently configured as outputs.
    out: int
    #: Pins currently configured as inputs (wire key ``in``).
    in_: int
    #: Timestamp phase resolution in nanoseconds (40).
    ts_res_ns: int
    #: Pattern tick in nanoseconds (200).
    tick_ns: int
    #: Maximum number of pattern steps (wire key ``pattern``).
    pattern_max: int
    #: Timestamp ring capacity in events.
    ring: int
    #: Feature bit mask (``FEAT_*``, wire key ``feat``).
    features: int

    def has_sync(self) -> bool:
        """True if bit 0 of ``features`` (sync capability) is set."""
        return (self.features & FEAT_SYNC) != 0

    def has_reset(self) -> bool:
        """True if the device supports ``pattern reset`` / ``reset`` /
        ``bootsel`` (FW v0.1.3+)."""
        return (self.features & FEAT_RESET) != 0

    def to_json_dict(self) -> dict[str, Any]:
        """The cross-language JSON form: ``in_`` is spelled ``in``."""
        data = asdict(self)
        data["in"] = data.pop("in_")
        return data


@dataclass
class DeviceInfo:
    uid: str
    device_number: int | None
    port: str
    version: str | None


@dataclass
class IoState:
    """``state`` response: input and output levels as physical GP bit
    masks (logical levels)."""

    inputs: int
    outputs: int


@dataclass
class PinMap:
    """v2 pin map: 8 ``key=value`` fields on the text protocol. All masks
    are physical GP bits."""

    #: Reserved, must be 0 in v2.
    flags: int
    #: ``dir``: 1 = output.
    direction: int
    #: ``pu``: pull-up (inputs only, exclusive with ``pull_down``).
    pull_up: int
    #: ``pd``: pull-down (inputs only).
    pull_down: int
    #: ``def``: initial output level (outputs only).
    out_default: int
    #: ``opol``: output polarity inversion (outputs only).
    out_polarity: int
    #: ``ipol``: input polarity inversion (inputs only).
    in_polarity: int
    #: ``edge``: inputs watched for ``! INPUT`` change events.
    edge: int

    @classmethod
    def default(cls) -> PinMap:
        """The device's default map: every pin an input with pull-down and
        edge events enabled (R-M4)."""
        return cls(
            flags=0,
            direction=0,
            pull_up=0,
            pull_down=VALID_DIO_MASK,
            out_default=0,
            out_polarity=0,
            in_polarity=0,
            edge=VALID_DIO_MASK,
        )

    def validate(self) -> None:
        """Check every R-M1 rule; the error names the offending field."""
        outputs = self.direction
        inputs = VALID_DIO_MASK & ~self.direction
        if self.flags != 0:
            raise InvalidArgumentError(
                f"flags {self.flags:#04x}: all bits are reserved and must be 0"
            )
        check_dio_mask("direction", self.direction)

        def subset(name: str, value: int, allowed: int, what: str) -> None:
            if value < 0 or value & ~allowed:
                raise InvalidArgumentError(
                    f"{name} {value:#010x} has bits that are not {what}"
                )

        subset("pull_up", self.pull_up, inputs, "DIO input pins")
        subset("pull_down", self.pull_down, inputs, "DIO input pins")
        if self.pull_up & self.pull_down:
            raise InvalidArgumentError(
                f"pull_up & pull_down {self.pull_up & self.pull_down:#010x}: "
                "a pin cannot have both pulls"
            )
        subset("out_default", self.out_default, outputs, "output pins")
        subset("out_polarity", self.out_polarity, outputs, "output pins")
        subset("in_polarity", self.in_polarity, inputs, "DIO input pins")
        subset("edge", self.edge, inputs, "DIO input pins")

    def to_set_args(self) -> str:
        """Arguments for ``map set``, which equal the payload of a
        ``map get`` response (R-M3). Refuses to encode an invalid map."""
        self.validate()
        return (
            f"v={PROTO_VERSION} flags={self.flags:#04x} "
            f"dir={self.direction:#010x} pu={self.pull_up:#010x} "
            f"pd={self.pull_down:#010x} def={self.out_default:#010x} "
            f"opol={self.out_polarity:#010x} ipol={self.in_polarity:#010x} "
            f"edge={self.edge:#010x}"
        )

    @classmethod
    def parse_get(cls, data: str) -> PinMap:
        """Parse the data of a ``map get`` response (``v=2 flags=... edge=...``).
        The map is validated, so an invalid device response is an error."""
        from .protocol import parse_map

        return parse_map(data)


@dataclass
class PatternStep:
    """One pattern step: output levels held for ``hold_ticks`` pattern
    ticks."""

    #: Logical output value (physical GP bits, subset of the direction mask).
    out_bits: int
    #: Hold time in pattern ticks of :data:`PATTERN_TICK_NS` ns; at least 1.
    hold_ticks: int

    def validate(self) -> None:
        """Check host-side limits: DIO bits only, 1..u32 ticks."""
        check_dio_mask("out_bits", self.out_bits)
        if not 1 <= self.hold_ticks <= _U32_MAX:
            raise InvalidArgumentError(
                f"hold_ticks {self.hold_ticks} must be between 1 and {_U32_MAX}"
            )

    def to_text(self) -> str:
        """Text form for ``pattern add``: ``<out_bits>:<hold_ticks>``,
        e.g. ``0x1:5``."""
        self.validate()
        return f"{self.out_bits:#x}:{self.hold_ticks}"

    def hold_ns(self) -> int:
        """Hold time in nanoseconds (the tick part only; the fixed ~133 ns
        PIO overhead of each step is not included, R-PT5)."""
        return self.hold_ticks * PATTERN_TICK_NS


def hold_ticks_from_ns(ns: int) -> int:
    """Convert a hold time in nanoseconds to pattern ticks. Only exact
    multiples of :data:`PATTERN_TICK_NS` are accepted (never rounded); the
    result must be between 1 and ``u32::MAX`` ticks."""
    if ns % PATTERN_TICK_NS != 0:
        raise InvalidArgumentError(
            f"{ns} ns is not a multiple of the {PATTERN_TICK_NS} ns pattern tick"
        )
    ticks = ns // PATTERN_TICK_NS
    if ticks < 1:
        raise InvalidArgumentError("hold time must be at least one tick")
    if ticks > _U32_MAX:
        raise InvalidArgumentError(f"{ns} ns exceeds the u32 tick range")
    return ticks


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
    """``pattern status`` response."""

    state: PatternState
    #: Step being output while running, else 0.
    step: int
    #: Completed passes.
    loops: int
    #: Number of steps in the pattern buffer.
    total: int


class EdgeMode(str, Enum):
    RISING = "rising"
    FALLING = "falling"
    BOTH = "both"


@dataclass
class TsStatus:
    """``ts status`` response."""

    armed: bool
    #: Events waiting in the device ring.
    pending: int
    #: The ring overflowed since the last ``ts get``.
    overflow: bool


def timestamp_ns(count: int, phase: int, sync_active: bool, ts_res_ns: int) -> int:
    """The single definition of a timestamp in nanoseconds (R-TS1): with
    sync active ``count * 1000 + phase * ts_res_ns``; free running the
    phase is not a time and is ignored. Used by :meth:`TimestampEvent.ns`
    and by reconcile."""
    base = count * 1000
    if sync_active:
        return base + phase * ts_res_ns
    return base


@dataclass
class TimestampEvent:
    """One captured edge: ``in=<inputs> c=<count> p=<phase> s=<sync>``."""

    #: Logical input values within the armed mask (polarity applied).
    inputs: int
    raw_count: int
    raw_phase: int
    sync_active: bool

    def ns(self, ts_res_ns: int) -> int:
        """Nanosecond timestamp (R-TS1): with sync active
        ``count * 1000 + phase * ts_res_ns``; free running, ``count`` is
        TIMER0 microseconds and the phase is always 0. ``ts_res_ns`` comes
        from :attr:`Capabilities.ts_res_ns`; the SDK has no resolution
        constant."""
        return timestamp_ns(self.raw_count, self.raw_phase, self.sync_active, ts_res_ns)


@dataclass
class TimestampResult:
    events: list[TimestampEvent] = field(default_factory=list)
    #: ``True`` if the FW reported a ring overflow since the last ``ts get``
    #: (i.e. events were dropped).
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
    """``! INPUT in=0x%08x t=<u64 us>``: logical input word and detection
    time in microseconds."""

    inputs: int
    t_us: int


@dataclass
class PatternDoneEvent:
    loops: int


@dataclass
class PatternTimeoutEvent:
    """Pattern aborted by the FW wall-clock safety budget. The output latch
    keeps the last step value until the host issues ``write`` or
    ``pattern reset``."""

    loops: int


PushEvent = InputChangeEvent | PatternDoneEvent | PatternTimeoutEvent
