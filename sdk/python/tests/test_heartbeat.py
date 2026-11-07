"""Watchdog heartbeat helper (docs/sdk-api-design.md "Heartbeat"). Mirrors
the tests of ``sdk/rust/src/heartbeat.rs``. The fake device answers ``ping``
with the golden ``OK pong=<n>`` shape, ``help`` with a counted response and
nothing else."""

from __future__ import annotations

import threading
import time

import pytest

import pochi
from pochi import Connection
from pochi.errors import (
    BusyError,
    InvalidArgumentError,
    SdkError,
    TimeoutError_,
)
from pochi.heartbeat import Heartbeat, heartbeat_period

from .fake_port import FakePort
from .golden import first_response

HELP = [
    "OK count=2",
    "  version  Get firmware version",
    "  help  Show this help",
]


def make_port(on_ping=None, *, answer_ping: bool = True) -> FakePort:
    port = FakePort()
    pings = {"n": 0}

    def on_command(line: str) -> None:
        if line == "version":
            port.feed(first_response("version-info", "version")[0])
        elif line == "help":
            port.feed(*HELP)
        elif line.startswith("ping "):
            n = pings["n"]
            pings["n"] += 1
            if on_ping is not None:
                reply = on_ping(n, line)
                if reply is not None:
                    port.feed(*reply)
                    return
            if answer_ping:
                port.feed(f"OK pong={line.split()[1]}")
        else:
            port.feed("ERR UNKNOWN_CMD")

    port.on_command = on_command
    return port


def pings(port: FakePort) -> list[str]:
    return [c for c in port.written if c.startswith("ping ")]


def wait_until(predicate, timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.005)
    return predicate()


def test_the_period_is_a_quarter_of_the_timeout_capped_at_one_second():
    for timeout_ms, ms in [
        (100, 25),
        (101, 25),
        (400, 100),
        (3999, 999),
        (4000, 1000),
        (4001, 1000),
        (10_000, 1000),
    ]:
        assert heartbeat_period(timeout_ms) == ms / 1000, timeout_ms


@pytest.mark.parametrize("bad", [0, 1, 99, 10_001, 0xFFFFFFFF, -100])
def test_a_disabled_or_out_of_range_timeout_has_no_heartbeat(bad):
    with pytest.raises(InvalidArgumentError):
        heartbeat_period(bad)
    port = make_port()
    with Connection.from_port(port) as conn, pytest.raises(InvalidArgumentError):
        conn.start_heartbeat(bad)
    assert port.written == ["version"]


def test_pings_go_out_every_period_with_distinct_values_until_stopped():
    port = make_port()
    conn = Connection.from_port(port)
    hb = conn.start_heartbeat(100)
    assert isinstance(hb, Heartbeat) and hb.period == 0.025
    time.sleep(0.3)
    assert hb.is_running
    assert hb.try_failure() is None
    hb.stop()
    assert not hb.is_running

    sent = pings(port)
    assert len(sent) >= 4, sent
    # Every ping is distinct: a stale answer cannot satisfy a later one.
    assert len(set(sent)) == len(sent)
    assert sent[0] == "ping 0"
    assert sent == [f"ping {i}" for i in range(len(sent))]
    # Stopped: nothing more arrives.
    time.sleep(0.1)
    assert len(pings(port)) == len(sent)
    conn.close()


def test_the_first_ping_is_sent_one_period_after_the_start():
    port = make_port()
    with Connection.from_port(port) as conn:
        hb = conn.start_heartbeat(400)  # period 100 ms
        time.sleep(0.03)
        assert pings(port) == []
        hb.stop()


def test_a_failure_is_reported_once_and_never_retried():
    port = make_port(lambda n, line: ["ERR BUSY"] if n == 1 else None)
    seen: list[SdkError] = []
    with Connection.from_port(port) as conn:
        hb = conn.start_heartbeat(100, on_failure=seen.append)
        failure = hb.wait_failure(2.0)
        assert isinstance(failure, BusyError)
        # Reported once through the poll API ...
        assert hb.try_failure() is None
        # ... and once through the callback.
        assert wait_until(lambda: len(seen) == 1) and isinstance(seen[0], BusyError)
        # Many periods later: no third ping, and the thread has ended.
        time.sleep(0.25)
        assert len(pings(port)) == 2, port.written
        assert not hb.is_running


def test_a_silent_device_fails_the_heartbeat_with_a_timeout():
    port = make_port(answer_ping=False)
    with Connection.from_port(port) as conn:
        conn.set_timeout(0.06)
        hb = conn.start_heartbeat(100)
        assert isinstance(hb.wait_failure(2.0), TimeoutError_)


def test_a_wrong_pong_fails_the_heartbeat():
    port = make_port(lambda n, line: ["OK pong=4000000000"])
    with Connection.from_port(port) as conn:
        hb = conn.start_heartbeat(100)
        failure = hb.wait_failure(2.0)
        assert isinstance(failure, pochi.ParseError)


def test_raise_if_failed_raises_the_failure_on_the_next_call():
    port = make_port(lambda n, line: ["ERR BUSY"])
    with Connection.from_port(port) as conn:
        hb = conn.start_heartbeat(100)
        assert wait_until(lambda: not hb.is_running)
        with pytest.raises(BusyError):
            hb.raise_if_failed()
        hb.raise_if_failed()  # delivered once


def test_raise_if_failed_is_quiet_while_healthy():
    port = make_port()
    with Connection.from_port(port) as conn:
        hb = conn.start_heartbeat(100)
        time.sleep(0.06)
        hb.raise_if_failed()
        hb.stop()


def test_a_raising_callback_does_not_lose_the_failure(caplog):
    def boom(_: SdkError) -> None:
        raise RuntimeError("callback bug")

    port = make_port(lambda n, line: ["ERR BUSY"])
    with Connection.from_port(port) as conn:
        hb = conn.start_heartbeat(100, on_failure=boom)
        assert isinstance(hb.wait_failure(2.0), BusyError)
    assert "callback" in caplog.text


def test_commands_from_the_caller_are_never_mixed_with_heartbeat_pings():
    port = make_port()
    with Connection.from_port(port) as conn:
        hb = conn.start_heartbeat(100)
        end = time.monotonic() + 0.4
        n = 0
        while time.monotonic() < end:
            # A counted response and plain responses while the heartbeat
            # fires every 25 ms: every one must get its own answer.
            assert len(conn.raw("help")) == 3
            assert conn.ping(1_000_000 + n) == 1_000_000 + n
            n += 1
        assert n > 10
        assert hb.try_failure() is None, "heartbeat saw a bad exchange"
        assert hb.is_running
        heartbeat_pings = [p for p in pings(port) if int(p.split()[1]) < 1_000_000]
        assert len(heartbeat_pings) >= 4, pings(port)
        hb.stop()


def test_closing_the_connection_ends_the_heartbeat_without_any_command():
    port = make_port()
    conn = Connection.from_port(port)
    hb = conn.start_heartbeat(100)
    time.sleep(0.08)
    conn.close()
    assert wait_until(lambda: not hb.is_running)
    # A closed connection is not a failure.
    assert hb.try_failure() is None
    hb.stop()
    # Only the handshake and pings: no write, no outputs reset, no wdog.
    assert all(c == "version" or c.startswith("ping ") for c in port.written)


def test_closing_during_a_ping_in_flight_is_not_a_failure():
    gate = threading.Event()

    def slow(n, line):
        gate.wait(0.5)

    port = make_port(slow)
    conn = Connection.from_port(port)
    hb = conn.start_heartbeat(100)
    assert wait_until(lambda: len(pings(port)) == 1)
    conn.close()
    gate.set()
    assert wait_until(lambda: not hb.is_running)
    assert hb.try_failure() is None


def test_stopping_or_closing_sends_no_command():
    port = make_port()
    conn = Connection.from_port(port)
    hb = conn.start_heartbeat(100)
    time.sleep(0.06)
    hb.stop()
    conn.close()
    assert all(c == "version" or c.startswith("ping ") for c in port.written)


def test_stop_is_idempotent_and_the_heartbeat_is_a_context_manager():
    port = make_port()
    with Connection.from_port(port) as conn:
        with conn.start_heartbeat(100) as hb:
            assert hb.is_running
        assert not hb.is_running
        hb.stop()


def test_starting_on_a_closed_connection_is_refused():
    conn = Connection.from_port(make_port())
    conn.close()
    with pytest.raises(InvalidArgumentError):
        conn.start_heartbeat(100)
