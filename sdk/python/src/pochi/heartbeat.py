"""Watchdog heartbeat helper (protocol-reference.md section 4, "Safety").
Mirrors ``sdk/rust/src/heartbeat.rs``.

The device trips its watchdog when it sees no ``OK`` answer for the timeout
given to ``wdog``. Whoever enables the watchdog must keep the device busy:
:meth:`pochi.Connection.start_heartbeat` starts a dedicated thread that sends
``ping <n>`` periodically. The rules, shared by every SDK
(docs/sdk-api-design.md, "Heartbeat"):

- **Period** = ``timeout / 4``, at most 1 s (:func:`heartbeat_period`).
  The first ping is sent one period after the start.
- **Serialised.** A heartbeat ``ping`` is a normal command exchange: the
  transport holds its command lock for the whole request and response, so
  the ping is never written between another command and its response, nor
  inside a counted response, and a caller's command is never interleaved with
  it. A long command of the caller (for example ``map save``) delays the
  ping; choose a timeout above the longest flash operation plus the period.
- **A failure is reported once and not retried.** The first failed ping
  (timeout, ``ERR``, wrong ``pong``, disconnect) is delivered through the
  ``on_failure`` callback, :meth:`Heartbeat.try_failure` /
  :meth:`Heartbeat.wait_failure` and :meth:`Heartbeat.raise_if_failed`, and
  the thread ends. It sends no further ping and repairs nothing: the device
  trips its watchdog, which is the safe outcome.
- **Closing changes nothing.** Stopping the heartbeat and closing the
  connection send no command and change no output. A heartbeat does not keep a
  closed connection alive: it ends silently (not a failure). Without a
  heartbeat the device trips ``timeout`` after the last ``OK``; a one-shot
  script that enables the watchdog therefore trips the device when it exits.
"""

from __future__ import annotations

import logging
import queue
import threading
import weakref
from collections.abc import Callable
from typing import TYPE_CHECKING

from .errors import InvalidArgumentError
from .types import WDOG_MAX_MS, WDOG_MIN_MS

if TYPE_CHECKING:
    # Type-checking only: `Self` is never imported at runtime (Python 3.10
    # has no `typing.Self` and the SDK has no typing_extensions dependency).
    from typing_extensions import Self

    from .connection import Connection

logger = logging.getLogger("pochi")

#: Longest heartbeat period in seconds.
MAX_PERIOD = 1.0

#: ``ping`` values are u32 and wrap.
_U32_MASK = 0xFFFFFFFF

FailureCallback = Callable[[Exception], None]


def heartbeat_period(timeout_ms: int) -> float:
    """The heartbeat period in seconds for a watchdog timeout: ``timeout /
    4`` (whole milliseconds), at most 1 s. ``timeout_ms`` must be a value
    ``wdog`` accepts for an enabled watchdog (``100..=10000``); ``0``
    (disabled) needs no heartbeat and is refused."""
    if not WDOG_MIN_MS <= timeout_ms <= WDOG_MAX_MS:
        raise InvalidArgumentError(
            f"heartbeat needs an enabled watchdog timeout between {WDOG_MIN_MS} "
            f"and {WDOG_MAX_MS} ms, got {timeout_ms}"
        )
    return min((timeout_ms // 4) / 1000, MAX_PERIOD)


class Heartbeat:
    """A running heartbeat; start one with
    :meth:`pochi.Connection.start_heartbeat`. :meth:`stop` (or leaving the
    ``with`` block) ends the thread; that sends nothing to the device, so the
    watchdog trips ``timeout`` after the last answered command unless
    something else keeps it fed."""

    def __init__(
        self,
        connection: Connection,
        timeout_ms: int,
        on_failure: FailureCallback | None = None,
    ) -> None:
        self.period = heartbeat_period(timeout_ms)
        self._connection = weakref.ref(connection)
        self._on_failure = on_failure
        self._stop = threading.Event()
        self._failures: queue.Queue[Exception] = queue.Queue()
        self._thread = threading.Thread(
            target=self._run, name="pochi-heartbeat", daemon=True
        )

    def _start(self) -> None:
        self._thread.start()

    # --- state ---

    @property
    def is_running(self) -> bool:
        """True while the thread is sending pings (false after a failure,
        after the connection was closed, and after :meth:`stop`)."""
        return self._thread.is_alive()

    def try_failure(self) -> Exception | None:
        """The failure that ended the heartbeat, if any (non-blocking). It is
        delivered once."""
        try:
            return self._failures.get_nowait()
        except queue.Empty:
            return None

    def wait_failure(self, timeout: float) -> Exception | None:
        """Wait up to ``timeout`` seconds for the failure that ends the
        heartbeat; ``None`` when none arrived."""
        try:
            return self._failures.get(timeout=timeout)
        except queue.Empty:
            return None

    def raise_if_failed(self) -> None:
        """Raise the failure that ended the heartbeat, if there is one (once).
        Call it from the code that relies on the watchdog being fed."""
        failure = self.try_failure()
        if failure is not None:
            raise failure

    # --- stopping ---

    def stop(self) -> None:
        """Stop sending pings and wait for the thread to end. Sends nothing
        to the device. An exchange in progress is finished first (at most one
        command timeout). Idempotent; from inside ``on_failure`` it does not
        wait for itself."""
        self._signal_stop()
        connection = self._connection()
        if connection is not None:
            connection._forget_heartbeat(self)
        if threading.current_thread() is not self._thread:
            self._thread.join()

    def _signal_stop(self) -> None:
        self._stop.set()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.stop()

    # --- the thread ---

    def _run(self) -> None:
        """Wait one period, ping, repeat. Ends when stopped, when the
        connection is closed, or after reporting the first failure."""
        value = 0
        while not self._stop.wait(self.period):
            connection = self._connection()
            # A closed connection: nothing to keep alive, not a failure.
            if connection is None or connection.closed:
                return
            try:
                connection.ping(value)
            except Exception as exc:  # noqa: BLE001 - thread boundary: reported, not swallowed
                # Any failure ends the heartbeat and is reported (never retried).
                # Closing the connection (or stopping) while the exchange was
                # in flight is not a heartbeat failure.
                if connection.closed or self._stop.is_set():
                    return
                self._report(exc)
                return
            finally:
                del connection
            value = (value + 1) & _U32_MASK

    def _report(self, failure: Exception) -> None:
        self._failures.put(failure)
        if self._on_failure is None:
            return
        try:
            self._on_failure(failure)
        except Exception:
            logger.exception("heartbeat on_failure callback raised")
