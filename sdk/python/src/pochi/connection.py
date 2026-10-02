"""High-level typed connection to one Pochi-DIO device.
Mirrors ``sdk/rust/src/connection.rs``.

Opening a connection asserts DTR and issues ``version``; any ``proto`` other
than 2 fails with :class:`~pochi.errors.UnsupportedFirmwareError` (R-U2).

The SDK owns ``subscribe``: :meth:`Connection.subscribe_events` returns an
:class:`EventSubscription`; the subscriber count of the connection going
0 -> 1 sends ``subscribe on``, 1 -> 0 sends ``subscribe off`` (R-H4). There
is one device subscription per connection, fanned out to every subscriber.
"""

from __future__ import annotations

import queue
import threading

from . import protocol
from .discovery import discover, find_by_device_number, find_by_uid, select_sole_device
from .errors import (
    InvalidArgumentError,
    ParseError,
    SdkError,
    UnsupportedFirmwareError,
)
from .transport import PortLike, Transport
from .types import (
    PROTO_VERSION,
    Capabilities,
    DeviceInfo,
    EdgeMode,
    IoState,
    PatternMode,
    PatternStatus,
    PatternStep,
    PinMap,
    PushEvent,
    TimestampResult,
    TsStatus,
    VersionInfo,
)


class EventSubscription:
    """A subscriber of the connection's push events (``! INPUT``,
    ``! PATTERN_DONE``, ``! PATTERN_TIMEOUT``).

    Events are queued as they arrive, including while commands are in
    flight. :meth:`close` (or leaving the ``with`` block) detaches the
    subscriber; the last one to leave turns the device subscription off.
    """

    def __init__(self, connection: Connection) -> None:
        self._connection = connection
        self._events: queue.Queue[PushEvent] = queue.Queue()
        self._closed = False

    def get(self, timeout: float | None = None) -> PushEvent:
        """Next event; blocks up to ``timeout`` seconds (forever when
        ``None``). Raises :class:`queue.Empty` when none arrived."""
        return self._events.get(timeout=timeout)

    def get_nowait(self) -> PushEvent:
        """Next event without blocking; raises :class:`queue.Empty`."""
        return self._events.get_nowait()

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        """Detach from the connection. Idempotent; a no-op once the
        connection itself is closed."""
        self._connection._unsubscribe(self)

    def __enter__(self) -> EventSubscription:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def _deliver(self, event: PushEvent) -> None:
        self._events.put(event)


class Connection:
    """An open connection to a Pochi-DIO device."""

    def __init__(self, transport: Transport, port_path: str) -> None:
        self._transport = transport
        self._port_path = port_path
        self._subscribers: list[EventSubscription] = []
        # Serialises subscriber-count transitions, including the
        # `subscribe on/off` command they trigger.
        self._subscription_lock = threading.Lock()
        # Guards the list itself. Separate because the reader thread takes it
        # to fan events out and must never wait for a command in flight (the
        # command's response is delivered by that same reader thread).
        self._list_lock = threading.Lock()
        self._closed = False
        self._transport.set_event_callback(self._fan_out)
        try:
            self._version = self._handshake()
        except BaseException:
            self._close_transport_after_failure()
            raise

    # --- constructors ---

    @classmethod
    def open(cls, port: str) -> Connection:
        """Open a connection to the device at the given serial port path:
        asserts DTR, sends ``version`` and requires ``proto=2``."""
        return cls(Transport.open(port), port)

    @classmethod
    def open_by_uid(cls, uid: str) -> Connection:
        """Discover devices and connect to the one with the given UID."""
        device = find_by_uid(discover(), uid)
        return cls.open(device.port)

    @classmethod
    def open_by_device_number(cls, n: int) -> Connection:
        """Discover devices and connect by device number."""
        device = find_by_device_number(discover(), n)
        return cls.open(device.port)

    @classmethod
    def open_sole_device(cls) -> Connection:
        """Discover devices and connect to the sole connected device."""
        device = select_sole_device(discover())
        return cls.open(device.port)

    @classmethod
    def from_port(cls, port: PortLike) -> Connection:
        """Wrap an already-open port (fake-port tests, custom transports).
        The same handshake as :meth:`open` runs."""
        return cls(Transport(port), "")

    # --- handshake ---

    def _handshake(self) -> VersionInfo:
        """``version`` must report ``proto=2`` (R-U2); nothing else is
        accepted, and nothing is parsed leniently."""
        data = self._transport.command("version")
        try:
            version = protocol.parse_version(data)
        except ParseError as exc:
            raise UnsupportedFirmwareError(
                f"unrecognised version response: {data!r}"
            ) from exc
        if version.protocol_version != PROTO_VERSION:
            raise UnsupportedFirmwareError(
                f"device reports proto={version.protocol_version}, "
                f"this SDK speaks proto={PROTO_VERSION} only"
            )
        return version

    def _close_transport_after_failure(self) -> None:
        try:
            self._transport.close()
        except SdkError:
            # The handshake error is the one the caller needs; a failure to
            # close a port that already failed to answer adds nothing.
            pass

    @property
    def protocol_version(self) -> int:
        """The ``proto`` the device reported when the connection opened."""
        return self._version.protocol_version

    # --- lifecycle ---

    def set_timeout(self, timeout: float) -> None:
        """Set the command response timeout in seconds (default 2.0)."""
        self._transport.timeout = timeout

    def close(self) -> None:
        """Close the connection. Subscribers are detached without sending
        ``subscribe off`` (closing the port drops DTR, which turns the
        device subscription off)."""
        with self._subscription_lock, self._list_lock:
            self._closed = True
            for sub in self._subscribers:
                sub._closed = True
            self._subscribers.clear()
        self._transport.close()

    def __enter__(self) -> Connection:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # --- device information ---

    def version(self) -> VersionInfo:
        """``version`` — firmware and protocol version."""
        return protocol.parse_version(self._transport.command("version"))

    def caps(self) -> Capabilities:
        """``caps`` — device capabilities."""
        return protocol.parse_caps(self._transport.command("caps"))

    def info(self) -> DeviceInfo:
        """``info`` — device identification (UID, device number); the
        firmware version is the ``fw=`` value of the opening handshake."""
        uid, device_number = protocol.parse_info(self._transport.command("info"))
        return DeviceInfo(
            uid=uid,
            device_number=device_number,
            port=self._port_path,
            version=self._version.fw,
        )

    def set_device_number(self, n: int) -> None:
        """``devnum <n>`` — set the device number (0-254; 255 unassigns)."""
        self._transport.command(protocol.devnum_command(n))

    def ping(self, value: int) -> int:
        """``ping <u32>`` — returns the echoed value; a different ``pong``
        is a :class:`~pochi.errors.ParseError`."""
        data = self._transport.command(protocol.ping_command(value))
        pong = protocol.parse_pong(data)
        if pong != value:
            raise ParseError(f"ping {value} was answered with pong={pong}")
        return pong

    # --- digital I/O ---

    def read(self) -> int:
        """``read`` — current input values (logical, physical GP bits)."""
        return protocol.parse_read(self._transport.command("read"))

    def write(self, values: int, mask: int) -> None:
        """``write <values> <mask>`` — set outputs (masked bits only).
        Bits outside the DIO pins are refused before sending."""
        self._transport.command(protocol.write_command(values, mask))

    def state(self) -> IoState:
        """``state`` — inputs and the output latch."""
        return protocol.parse_state(self._transport.command("state"))

    # --- pin map ---

    def map_get(self) -> PinMap:
        """``map get`` — current pin map (validated)."""
        return protocol.parse_map(self._transport.command("map get"))

    def map_set(self, pin_map: PinMap) -> None:
        """``map set`` from a typed :class:`PinMap`; validated (R-M1)
        before anything is sent. Fails with ``BusyError`` while a pattern
        runs; on success the device returns the pattern engine to idle and
        disarms the timestamp recorder."""
        self._transport.command(protocol.map_set_command(pin_map))

    def map_save(self) -> None:
        """``map save`` — persist the current map to flash."""
        self._transport.command("map save")

    def map_default(self) -> None:
        """``map default`` — reset to the default map (all inputs,
        pull-down, edge enabled)."""
        self._transport.command("map default")

    # --- pattern ---

    def pattern_add(self, steps: list[PatternStep]) -> int:
        """``pattern add`` — append steps to the pattern buffer, split into
        as many lines as the 256-byte line limit requires. Returns the
        total step count after the last line."""
        total = 0
        for line in protocol.pattern_add_commands(steps):
            total = protocol.parse_pattern_total(self._transport.command(line))
        return total

    def pattern_load(self, steps: list[PatternStep]) -> int:
        """Replace the pattern buffer: ``pattern reset``, then
        :meth:`pattern_add`. Every step is validated before anything is
        sent. Returns the total step count."""
        protocol.pattern_add_commands(steps)
        self.pattern_reset()
        return self.pattern_add(steps)

    def pattern_run(self, mode: PatternMode, repeat: int) -> None:
        """``pattern run once`` / ``pattern run loop <repeat>`` — start
        playback. ``ONCE`` ignores ``repeat``; ``LOOP`` requires 1-65535
        (no infinite mode)."""
        self._transport.command(protocol.pattern_run_command(mode, repeat))

    def pattern_stop(self) -> None:
        """``pattern stop`` — stop playback. ``NotRunningError`` when the
        engine is not running; the loaded steps stay."""
        self._transport.command("pattern stop")

    def pattern_status(self) -> PatternStatus:
        """``pattern status`` — current playback status."""
        return protocol.parse_pattern_status(self._transport.command("pattern status"))

    def pattern_reset(self) -> None:
        """``pattern reset`` — abort any run, clear the buffer and return
        to ``IDLE``. USB stays up; the connection remains usable."""
        self._transport.command("pattern reset")

    # --- reset ---

    def system_reset(self) -> None:
        """``reset`` — reboot the device (RAM state returns to defaults,
        flash state is kept). The USB port re-enumerates, so the caller
        must close this connection and rediscover the device afterwards."""
        self._transport.command("reset")

    def bootsel_reset(self) -> None:
        """``bootsel`` — reboot into BOOTSEL mass-storage mode for UF2
        reflash. Like :meth:`system_reset`, callers must close this
        connection afterwards."""
        self._transport.command("bootsel")

    # --- timestamp ---

    def ts_arm(self, mask: int, mode: EdgeMode) -> None:
        """``ts arm <mask> <mode>`` — arm timestamp capture on the input
        pins of ``mask`` (non-zero, DIO pins only)."""
        self._transport.command(protocol.ts_arm_command(mask, mode))

    def ts_get(self, max_events: int) -> TimestampResult:
        """``ts get <max>`` — retrieve captured events (counted read).
        ``max_events`` is 1-85; anything else is refused before sending.

        The result carries no nanosecond values: use
        :meth:`pochi.types.TimestampEvent.ns` or the reconcile API with
        :attr:`Capabilities.ts_res_ns`. ``overflow`` is ``True`` if the
        ring overwrote events since the last ``ts get``."""
        command = protocol.ts_get_command(max_events)
        data, lines = self._transport.command_counted(command)
        count, overflow = protocol.parse_ts_get_header(data)
        if count != len(lines):
            raise ParseError(
                f"ts get header announced {count} events but {len(lines)} lines were read"
            )
        return TimestampResult(
            events=[protocol.parse_ts_event_line(line) for line in lines],
            overflow=overflow,
        )

    def ts_status(self) -> TsStatus:
        """``ts status`` — capture state and pending event count."""
        return protocol.parse_ts_status(self._transport.command("ts status"))

    def ts_disarm(self) -> None:
        """``ts disarm`` — disarm capture and discard buffered events."""
        self._transport.command("ts disarm")

    # --- events ---

    def subscribe_events(self) -> EventSubscription:
        """Attach a push-event subscriber. The first subscriber of the
        connection sends ``subscribe on``; if the device refuses, nothing is
        registered and the error is raised."""
        sub = EventSubscription(self)
        with self._subscription_lock:
            if self._closed:
                raise InvalidArgumentError("connection is closed")
            with self._list_lock:
                first = not self._subscribers
                self._subscribers.append(sub)
            if first:
                try:
                    self._transport.command("subscribe on")
                except BaseException:
                    with self._list_lock:
                        self._subscribers.remove(sub)
                    raise
        return sub

    def _unsubscribe(self, sub: EventSubscription) -> None:
        with self._subscription_lock:
            with self._list_lock:
                sub._closed = True
                if sub not in self._subscribers:
                    return
                self._subscribers.remove(sub)
                last = not self._subscribers
            if last:
                self._transport.command("subscribe off")

    def _fan_out(self, event: PushEvent) -> None:
        """Transport event callback (reader thread): deliver to every
        subscriber. With none attached the event is dropped (the device
        only sends INPUT events while subscribed)."""
        with self._list_lock:
            subscribers = list(self._subscribers)
        for sub in subscribers:
            sub._deliver(event)

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
        """``sync count`` — sync clock edges since the sync edge. A single
        ``OK clocks=<n>`` line, not a counted response."""
        return protocol.parse_sync_count(self._transport.command("sync count"))

    def sync_disarm(self) -> None:
        """``sync disarm`` — release sync state (safe in any state)."""
        self._transport.command("sync disarm")

    # --- escape hatch ---

    def raw(self, command: str) -> list[str]:
        """Send an arbitrary text command and return **every** line of the
        response (for a counted response: the header and all N lines) under
        the same transport rules as every other command. A device error is
        returned as its ``ERR <NAME>`` line.

        Lines over 256 bytes, lines containing CR/LF and ``subscribe``
        (owned by the SDK) are refused before sending."""
        if "\r" in command or "\n" in command:
            raise InvalidArgumentError("command must not contain CR/LF")
        if len(command.encode()) > protocol.MAX_LINE_BYTES:
            raise InvalidArgumentError(
                f"command line exceeds {protocol.MAX_LINE_BYTES} bytes"
            )
        words = command.split()
        if words and words[0].lower() == "subscribe":
            raise InvalidArgumentError(
                "subscribe is owned by the SDK; use subscribe_events()"
            )
        return self._transport.raw_exchange(command)
