"""High-level typed connection to one Pochi-DIO device.
Mirrors ``sdk/rust/src/connection.rs``. Push events are delivered to a
callback on a background thread (:meth:`Connection.set_event_callback`);
the connection is also a context manager."""

from __future__ import annotations

from . import protocol
from .discovery import discover, find_by_device_number, find_by_uid, select_sole_device
from .transport import EventCallback, PortLike, Transport
from .types import (
    MAP_V2_CHANNEL_LINES,
    Capabilities,
    DeviceInfo,
    EdgeMode,
    IoState,
    PatternMode,
    PatternStatus,
    PatternStep,
    PinMap,
    PinMapV2,
    TimestampResult,
    VersionInfo,
)


class Connection:
    """An open connection to a Pochi-DIO device."""

    def __init__(self, transport: Transport, port_path: str) -> None:
        self._transport = transport
        self._port_path = port_path

    # --- constructors ---

    @classmethod
    def open(cls, port: str) -> "Connection":
        """Open a connection to the device at the given serial port path."""
        return cls(Transport.open(port), port)

    @classmethod
    def open_by_uid(cls, uid: str) -> "Connection":
        """Discover devices and connect to the one with the given UID."""
        device = find_by_uid(discover(), uid)
        return cls.open(device.port)

    @classmethod
    def open_by_device_number(cls, n: int) -> "Connection":
        """Discover devices and connect by device number."""
        device = find_by_device_number(discover(), n)
        return cls.open(device.port)

    @classmethod
    def open_sole_device(cls) -> "Connection":
        """Discover devices and connect to the sole connected device."""
        device = select_sole_device(discover())
        return cls.open(device.port)

    @classmethod
    def from_port(cls, port: PortLike) -> "Connection":
        """Wrap an already-open port (fake-port tests, custom transports)."""
        return cls(Transport(port), "")

    # --- lifecycle ---

    def set_timeout(self, timeout: float) -> None:
        """Set the command response timeout in seconds (default 2.0)."""
        self._transport.timeout = timeout

    def close(self) -> None:
        """Close the connection."""
        self._transport.close()

    def __enter__(self) -> "Connection":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # --- device information ---

    def version(self) -> VersionInfo:
        """``version`` — firmware and protocol version."""
        return protocol.parse_version(self._transport.command("version"))

    def caps(self) -> Capabilities:
        """``caps`` — device capabilities (protocol version filled in from
        ``version``). Raises UnsupportedFirmwareError on pre-9.6 FW."""
        caps = protocol.parse_caps(self._transport.command("caps"))
        caps.protocol_version = self.version().protocol_version
        return caps

    def info(self) -> DeviceInfo:
        """``info`` — device identification (UID, device number)."""
        uid, device_number = protocol.parse_info(self._transport.command("info"))
        return DeviceInfo(
            uid=uid, device_number=device_number, port=self._port_path, version=None
        )

    def set_device_number(self, n: int) -> None:
        """``devnum <n>`` — set the device number (0-254; 255 unassigns)."""
        self._transport.command(f"devnum {n}")

    # --- digital I/O ---

    def read(self) -> int:
        """``read`` — current input values."""
        return protocol.parse_read(self._transport.command("read"))

    def write(self, values: int, mask: int) -> None:
        """``write <values> <mask>`` — set outputs (masked bits only)."""
        self._transport.command(f"write {values:#x} {mask:#x}")

    def state(self) -> IoState:
        """``state`` — complete I/O state."""
        return protocol.parse_state(self._transport.command("state"))

    # --- pin map ---

    def map_get(self) -> PinMap | PinMapV2:
        """``map get`` — current pin map. Returns a v1 ``PinMap`` or a
        v2 ``PinMapV2`` depending on the FW's ``v=`` field.

        v2 headers are followed by 25 ``chN: OUT/IN`` detail lines that
        populate ``PinMapV2.direction_mask``/``channels``; v1 headers
        carry no such lines. The command is sent exactly once: the
        header is read first (deciding the version), and only then, if
        v2, are the 25 trailing lines pulled from the same response
        stream (already in flight from the device — no second command).
        """
        header = self._transport.command("map get")
        if protocol.parse_map_version(header) >= 2:
            lines = self._transport.recv_lines(MAP_V2_CHANNEL_LINES)
            return protocol.parse_map(header, lines)
        return protocol.parse_map(header)

    def map_set(self, pin_map: PinMap | PinMapV2) -> None:
        """``map set`` from a typed PinMap or PinMapV2 (fields not
        observable over the text protocol default per FW ``parse_map_set_v2``)."""
        if isinstance(pin_map, PinMapV2):
            self.map_set_hex(protocol.map_v2_to_hex(pin_map))
        else:
            self.map_set_hex(protocol.map_to_hex(pin_map))

    def map_set_hex(self, hex_str: str) -> None:
        """``map set <hex>`` — raw 48-char hex map."""
        self._transport.command(f"map set {hex_str}")

    def map_save(self) -> None:
        """``map save`` — persist the current map to flash."""
        self._transport.command("map save")

    def map_default(self) -> None:
        """``map default`` — reset to the default map (all inputs)."""
        self._transport.command("map default")

    # --- pattern ---

    def pattern_load(self, steps: list[PatternStep]) -> int:
        """``pattern load`` from typed steps. Returns accepted count."""
        return self.pattern_load_hex(protocol.pattern_to_hex(steps))

    def pattern_load_hex(self, hex_str: str) -> int:
        """``pattern load <hex>`` — raw count-prefixed step data."""
        return protocol.parse_accepted(
            self._transport.command(f"pattern load {hex_str}")
        )

    def pattern_run(self, mode: PatternMode, repeat: int) -> None:
        """``pattern run <mode> <repeat>`` — start playback. Note:
        ``loop`` with repeat=0 is rejected by FW (no infinite mode)."""
        self._transport.command(protocol.pattern_run_command(mode, repeat))

    def pattern_stop(self) -> None:
        """``pattern stop`` — stop playback immediately."""
        self._transport.command("pattern stop")

    def pattern_status(self) -> PatternStatus:
        """``pattern status`` — current playback status."""
        return protocol.parse_pattern_status(self._transport.command("pattern status"))

    def pattern_reset(self) -> None:
        """``pattern reset`` — pattern engine soft reset (FW v0.1.3+,
        ``FEAT_RESET``).

        Stops the state machine, clears the loaded pattern buffer, and
        returns the engine to ``Idle``. USB stays up; the connection
        remains usable.
        """
        self._transport.command("pattern reset")

    # --- reset ---

    def system_reset(self) -> None:
        """``reset`` — full chip soft reset (FW v0.1.3+, ``FEAT_RESET``).

        The device responds ``OK``, drains its CDC TX ring for ~50 ms, then
        calls ``SCB::sys_reset()``. The USB port re-enumerates, so the
        caller must close this connection and rediscover the device
        afterwards.
        """
        self._transport.command("reset")

    def bootsel_reset(self) -> None:
        """``bootsel`` — reboot into BOOTSEL mass-storage mode for UF2
        reflash (FW v0.1.3+, ``FEAT_RESET``).

        Like :meth:`system_reset`, the device re-enumerates afterwards
        (as a USB mass-storage device). Callers must close this connection.
        """
        self._transport.command("bootsel")

    # --- timestamp ---

    def ts_arm(self, mask: int, mode: EdgeMode) -> None:
        """``ts arm <mask> <mode>`` — arm timestamp capture."""
        self._transport.command(protocol.ts_arm_command(mask, mode))

    def ts_get(self, max_events: int) -> TimestampResult:
        """``ts get <max>`` — retrieve captured events (counted read).

        ``timestamp_ns`` is the host-computed as-is value; apply the
        reconcile module for straddle correction across events.

        ``TimestampResult.overflow`` is ``True`` if the FW reported a ring
        overflow since the last ``ts get`` (FW v0.1.2+). ``max_events`` is
        clamped FW-side: as of FW v0.1.2 a single response carries at most
        85 events, so draining a full 256-event ring may need multiple calls.
        """
        data, lines = self._transport.command_counted(f"ts get {max_events}")
        _, overflow = protocol.parse_count_overflow_field(data)
        return TimestampResult(
            events=[protocol.parse_ts_event_line(line) for line in lines],
            reconciled=False,
            overflow=overflow,
        )

    def ts_disarm(self) -> None:
        """``ts disarm`` — disarm capture and discard buffered events."""
        self._transport.command("ts disarm")

    # --- events ---

    def subscribe(self, enable: bool) -> None:
        """``subscribe on|off`` — toggle input change push notifications."""
        self._transport.command(f"subscribe {'on' if enable else 'off'}")

    def set_event_callback(self, callback: EventCallback | None) -> None:
        """Install a push event subscriber. The callback receives
        :class:`pochi.types.PushEvent` values on the reader thread,
        including while commands are in flight."""
        self._transport.set_event_callback(callback)

    # --- sync ---

    def sync_arm(self) -> None:
        """``sync arm`` — prepare as slave."""
        self._transport.command("sync arm")

    def sync_master(self) -> None:
        """``sync master`` — prepare as master."""
        self._transport.command("sync master")

    def sync_start(self) -> None:
        """``sync start`` — start sync pulse + 1 MHz clock (master only)."""
        self._transport.command("sync start")

    def sync_stop(self) -> None:
        """``sync stop`` — stop clock output (master only)."""
        self._transport.command("sync stop")

    def sync_count(self) -> int:
        """``sync count`` — current sync clock count. Single-line response
        (``OK count=N``, no data lines) — plain read path, never counted."""
        return protocol.parse_sync_count(self._transport.command("sync count"))

    def sync_disarm(self) -> None:
        """``sync disarm`` — release sync state (safe in any state)."""
        self._transport.command("sync disarm")

    # --- escape hatch ---

    def raw(self, command: str) -> str:
        """Send an arbitrary command, returning the raw response line."""
        return self._transport.raw(command)
