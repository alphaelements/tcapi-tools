import time

import pytest

from pochi.errors import (
    BadCommandError,
    DisconnectedError,
    NotArmedError,
    ParseError,
    TimeoutError_,
)
from pochi.transport import Transport
from pochi.types import InputChangeEvent, PatternDoneEvent, SyncDoneEvent, UnknownEvent

from .fake_port import FakePort


@pytest.fixture
def setup():
    port = FakePort()
    transport = Transport(port)
    yield transport, port
    port.closed = True


class TestCommand:
    def test_ok(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed("OK v0.1.0 proto=1")
        assert transport.command("version") == "v0.1.0 proto=1"
        assert port.written == ["version"]

    def test_device_error(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed("ERR UNKNOWN_CMD")
        with pytest.raises(BadCommandError):
            transport.command("bogus")

    def test_garbage_is_parse_error(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed("WHAT IS THIS")
        with pytest.raises(ParseError):
            transport.command("version")

    def test_timeout(self, setup):
        transport, _ = setup
        transport.timeout = 0.15
        with pytest.raises(TimeoutError_):
            transport.command("version")

    def test_push_interleaved(self, setup):
        transport, port = setup
        events = []
        transport.set_event_callback(events.append)
        port.on_command = lambda _: port.feed("! INPUT 0x000005 t=111", "OK 0x000003")
        assert transport.command("read") == "0x000003"
        deadline = time.monotonic() + 1.0
        while not events and time.monotonic() < deadline:
            time.sleep(0.01)
        assert events == [InputChangeEvent(inputs=5, timestamp_us=111)]

    def test_stale_lines_drained(self, setup):
        transport, port = setup
        port.feed("OK stale leftover")
        time.sleep(0.15)
        port.on_command = lambda _: port.feed("OK v0.1.0 proto=1")
        assert transport.command("version") == "v0.1.0 proto=1"

    def test_partial_line_assembled(self, setup):
        transport, port = setup

        def respond(_cmd):
            port.feed_raw("OK v0.")
            port.feed_raw("1.0 proto=1\r\n")

        port.on_command = respond
        assert transport.command("version") == "v0.1.0 proto=1"


class TestCountedRead:
    def test_exactly_n_lines(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(
            "OK count=2", "  0x00000005 c=1000 p=7 s=1", "  0x0000000A c=2000 p=12 s=0"
        )
        data, lines = transport.command_counted("ts get 256")
        assert data == "count=2"
        assert len(lines) == 2
        assert "c=1000" in lines[0]

    def test_count_zero(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed("OK count=0")
        data, lines = transport.command_counted("ts get 256")
        assert data == "count=0"
        assert lines == []

    def test_err_response(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed("ERR NOT_ARMED")
        with pytest.raises(NotArmedError):
            transport.command_counted("ts get 256")


class TestSyncCountDiscipline:
    def test_plain_command_returns_immediately(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed("OK count=1000000")
        start = time.monotonic()
        assert transport.command("sync count") == "count=1000000"
        assert time.monotonic() - start < 1.0


class TestRaw:
    def test_returns_unparsed_line(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed("ERR BAD_CMD")
        assert transport.raw("nope") == "ERR BAD_CMD"


class TestDisconnect:
    def test_pending_command_disconnects(self, setup):
        transport, port = setup
        transport.timeout = 1.0
        port.closed = True  # reader thread errors out on next read
        with pytest.raises(DisconnectedError):
            transport.command("version")

    def test_subsequent_commands_disconnect(self, setup):
        transport, port = setup
        port.closed = True
        time.sleep(0.15)
        with pytest.raises(DisconnectedError):
            transport.command("version")


class TestPushEvents:
    def test_all_event_types(self, setup):
        transport, port = setup
        events = []
        transport.set_event_callback(events.append)
        port.feed(
            "! INPUT 0x000001 t=100",
            "! PATTERN_DONE loops=3",
            "! SYNC_DONE status=ready devnum=1 ts=42",
        )
        deadline = time.monotonic() + 1.0
        while len(events) < 3 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert events == [
            InputChangeEvent(inputs=1, timestamp_us=100),
            PatternDoneEvent(loops=3),
            SyncDoneEvent(status="ready", devnum=1, timestamp=42),
        ]

    def test_malformed_push_as_unknown(self, setup):
        transport, port = setup
        events = []
        transport.set_event_callback(events.append)
        port.feed("! INPUT garbage")
        deadline = time.monotonic() + 1.0
        while not events and time.monotonic() < deadline:
            time.sleep(0.01)
        assert isinstance(events[0], UnknownEvent)
        assert "INPUT garbage" in events[0].raw
