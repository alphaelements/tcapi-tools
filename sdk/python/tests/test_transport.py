"""Transport contract (R-H1 to R-H4): one command / one response, counted
reads, ping resynchronisation, DTR. Device lines come from the golden
transcripts; hand-written lines appear only in the tests marked NEGATIVE
(malformed-input coverage, R-C4)."""

import logging
import threading
import time

import pytest

import tcapi.transport as transport_module
from tcapi.errors import (
    BadParamError,
    DisconnectedError,
    InvalidArgumentError,
    NotArmedError,
    ParseError,
    TimeoutError_,
    UnknownCmdError,
)
from tcapi.transport import Transport
from tcapi.types import InputChangeEvent, PatternDoneEvent

from .fake_port import FakePort
from .golden import find_request, first_response

VERSION = first_response("version-info", "version")
TS_GET_2 = find_request("timestamp", "ts get", "count=2").response  # header + 2 lines
TS_GET_4 = find_request("timestamp", "ts get", "count=4").response
HELP = find_request("reset", "help", "count=").response
TS_EMPTY = find_request("timestamp", "ts get", "count=0").response
INPUT_EVENT = "! INPUT in=0x00000001 t=5"
PATTERN_DONE = "! PATTERN_DONE loops=1"


@pytest.fixture
def setup():
    port = FakePort()
    transport = Transport(port)
    transport.timeout = 0.5
    yield transport, port
    port.closed = True


def wait_for(predicate, timeout=1.0):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.01)
    return predicate()


def answer_ping(port, *, before=(), after=()):
    """Fake device that answers ``ping N`` with ``OK pong=N`` (what the
    protocol prescribes), optionally preceded/followed by extra lines."""

    def respond(line: str) -> None:
        cmd, _, arg = line.partition(" ")
        if cmd == "ping":
            port.feed(*before, f"OK pong={arg}", *after)

    return respond


class TestCommand:
    def test_ok(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(*VERSION)
        assert transport.command("version") == "fw=0.1.3 proto=2"
        assert port.written == ["version"]

    def test_commands_end_with_crlf(self, setup):
        transport, port = setup
        raw = []
        original = port.write
        port.write = lambda data: raw.append(data) or original(data)
        port.on_command = lambda _: port.feed("OK")
        transport.command("devnum 7")
        assert raw == [b"devnum 7\r\n"]

    def test_device_error_is_typed(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(*first_response("errors", "nonsense"))
        with pytest.raises(UnknownCmdError):
            transport.command("nonsense")

    def test_error_does_not_desync(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed("ERR BAD_PARAM")
        with pytest.raises(BadParamError):
            transport.command("devnum 256")
        assert not transport.desynced
        port.on_command = lambda _: port.feed(*VERSION)
        transport.command("version")
        assert port.written == ["devnum 256", "version"]  # no ping in between

    def test_timeout(self, setup):
        transport, _ = setup
        transport.timeout = 0.15
        with pytest.raises(TimeoutError_):
            transport.command("version")
        assert transport.desynced

    def test_partial_line_assembled(self, setup):
        transport, port = setup

        def respond(_cmd):
            port.feed_raw("OK fw=0.")
            port.feed_raw("1.3 proto=2\r\n")

        port.on_command = respond
        assert transport.command("version") == "fw=0.1.3 proto=2"

    def test_cr_only_blank_lines_ignored(self, setup):
        transport, port = setup
        port.on_command = lambda _: (port.feed_raw("\r\n\r\n"), port.feed(*VERSION))
        assert transport.command("version") == "fw=0.1.3 proto=2"

    def test_no_drain_helper_exists(self):
        # R-H1: there is no "drain stale lines" step any more; resync is
        # the only recovery path.
        assert not hasattr(Transport, "_drain_stale_responses")
        assert not hasattr(Transport, "command_fixed_lines")
        assert not hasattr(Transport, "recv_lines")


class TestCountedRead:
    """R-H3: a header with ``count=N`` is followed by exactly N lines."""

    def test_exactly_n_lines(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(*TS_GET_2)
        data, lines = transport.command_counted("ts get 10")
        assert data == "count=2 overflow=0"
        assert lines == TS_GET_2[1:]

    def test_four_events(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(*TS_GET_4)
        _, lines = transport.command_counted("ts get 10")
        assert lines == TS_GET_4[1:]
        assert len(lines) == 4

    def test_count_zero_reads_nothing_more(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(*TS_EMPTY)
        start = time.monotonic()
        data, lines = transport.command_counted("ts get 85")
        assert data == "count=0 overflow=0"
        assert lines == []
        assert time.monotonic() - start < 0.4  # did not wait for lines

    def test_help_is_counted(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(*HELP)
        data, lines = transport.command_counted("help")
        assert data == HELP[0].removeprefix("OK ")
        assert lines == HELP[1:]

    def test_next_command_after_counted_response_is_not_offset(self, setup):
        transport, port = setup
        responses = {"ts get 10": TS_GET_2, "version": VERSION}
        port.on_command = lambda line: port.feed(*responses[line])
        transport.command_counted("ts get 10")
        assert transport.command("version") == "fw=0.1.3 proto=2"

    def test_error_instead_of_header(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed("ERR NOT_ARMED")
        with pytest.raises(NotArmedError):
            transport.command_counted("ts get 1")
        assert not transport.desynced

    def test_continuation_lines_with_leading_spaces_are_kept_verbatim(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(*TS_GET_2)
        _, lines = transport.command_counted("ts get 10")
        assert all(line.startswith("  in=") for line in lines)

    def test_single_line_command_refuses_a_counted_response(self, setup):
        # command() is for single-line responses. If a device answers it with
        # a counted one, the announced lines are still consumed (so the
        # stream stays in step) and the mismatch is an error, not data loss.
        transport, port = setup
        port.on_command = lambda _: port.feed(*TS_GET_2)
        with pytest.raises(ParseError, match="counted"):
            transport.command("read")
        assert not transport.desynced
        port.on_command = lambda _: port.feed(*VERSION)
        assert transport.command("version") == "fw=0.1.3 proto=2"

    def test_counted_command_refuses_a_single_line_response(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(*VERSION)
        with pytest.raises(ParseError, match="count="):
            transport.command_counted("version")
        assert not transport.desynced

    def test_count_must_be_a_number(self, setup):
        # NEGATIVE: malformed header
        transport, port = setup
        port.on_command = lambda _: port.feed("OK count=abc")
        with pytest.raises(ParseError):
            transport.command_counted("ts get 1")
        assert transport.desynced

    def test_non_continuation_line_inside_count_desyncs(self, setup):
        # NEGATIVE: the second "continuation" line is not indented
        transport, port = setup
        port.on_command = lambda _: port.feed(TS_GET_2[0], TS_GET_2[1], "OK pong=1")
        with pytest.raises(ParseError):
            transport.command_counted("ts get 10")
        assert transport.desynced


class TestRawExchange:
    def test_returns_every_line_of_a_counted_response(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(*HELP)
        assert transport.raw_exchange("help") == HELP

    def test_returns_an_error_line_without_raising(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed("ERR UNKNOWN_CMD")
        assert transport.raw_exchange("nonsense") == ["ERR UNKNOWN_CMD"]
        assert not transport.desynced

    def test_single_line(self, setup):
        transport, port = setup
        port.on_command = lambda _: port.feed(*VERSION)
        assert transport.raw_exchange("version") == VERSION


class TestResync:
    """R-H2: a timeout, an unparseable line or a short counted response puts
    the connection in desync; the next operation first sends
    ``ping <random u32>`` and discards lines until ``OK pong=<same value>``."""

    def test_stale_lines_are_discarded_until_the_matching_pong(self, setup):
        transport, port = setup
        transport.timeout = 0.2
        # 1. The device never answers: timeout, desync.
        with pytest.raises(TimeoutError_):
            transport.command("read")
        assert transport.desynced

        # 2. The late (stale) answers arrive, then the device answers the
        #    resync ping and the real command.
        stale = ["OK in=0x00000001", "OK", *TS_GET_2[1:]]

        def respond(line):
            cmd, _, arg = line.partition(" ")
            if cmd == "ping":
                port.feed(*stale, f"OK pong={arg}")
            elif cmd == "version":
                port.feed(*VERSION)

        port.on_command = respond
        transport.timeout = 0.5
        assert transport.command("version") == "fw=0.1.3 proto=2"
        assert not transport.desynced
        assert port.written[0] == "read"
        assert port.written[1].startswith("ping ")
        assert port.written[2:] == ["version"]

    def test_ping_value_is_a_random_u32(self, setup):
        transport, port = setup
        values = []
        for _ in range(5):
            port.on_command = None
            transport.timeout = 0.1
            with pytest.raises(TimeoutError_):
                transport.command("read")
            port.written.clear()
            port.on_command = lambda line: (
                answer_ping(port)(line)
                if line.startswith("ping")
                else port.feed(*VERSION)
            )
            transport.timeout = 0.5
            transport.command("version")
            values.append(int(port.written[0].split()[1]))
        assert all(0 <= v <= 0xFFFFFFFF for v in values)
        assert len(set(values)) == 5

    def test_only_the_matching_pong_ends_resync(self, setup):
        transport, port = setup
        transport.timeout = 0.15
        with pytest.raises(TimeoutError_):
            transport.command("read")

        def respond(line):
            cmd, _, arg = line.partition(" ")
            if cmd == "ping":
                other = (int(arg) + 1) & 0xFFFFFFFF
                port.feed(f"OK pong={other}", f"OK pong={arg}")
            elif cmd == "version":
                port.feed(*VERSION)

        port.on_command = respond
        transport.timeout = 0.5
        assert transport.command("version") == "fw=0.1.3 proto=2"

    def test_events_during_resync_go_to_the_event_path(self, setup):
        transport, port = setup
        events = []
        transport.set_event_callback(events.append)
        transport.timeout = 0.15
        with pytest.raises(TimeoutError_):
            transport.command("read")
        port.on_command = lambda line: (
            answer_ping(port, before=["OK stale", INPUT_EVENT, PATTERN_DONE])(line)
            if line.startswith("ping")
            else port.feed(*VERSION)
        )
        transport.timeout = 0.5
        assert transport.command("version") == "fw=0.1.3 proto=2"
        assert wait_for(lambda: len(events) == 2)
        assert events == [InputChangeEvent(inputs=1, t_us=5), PatternDoneEvent(loops=1)]

    def test_short_counted_response_desyncs_and_recovers(self, setup):
        transport, port = setup
        transport.timeout = 0.2
        # header promises 4 lines, only 2 arrive
        port.on_command = lambda _: port.feed(*TS_GET_4[:3])
        with pytest.raises(TimeoutError_):
            transport.command_counted("ts get 10")
        assert transport.desynced

        def respond(line):
            cmd, _, arg = line.partition(" ")
            if cmd == "ping":
                port.feed(*TS_GET_4[3:], f"OK pong={arg}")  # the missing lines, late
            else:
                port.feed(*VERSION)

        port.on_command = respond
        transport.timeout = 0.5
        assert transport.command("version") == "fw=0.1.3 proto=2"
        assert not transport.desynced

    def test_unparseable_line_desyncs_and_recovers(self, setup):
        # NEGATIVE: hand-written garbage line
        transport, port = setup
        port.on_command = lambda _: port.feed("this is not a protocol line")
        with pytest.raises(ParseError):
            transport.command("version")
        assert transport.desynced

        def respond(line):
            if line.startswith("ping"):
                answer_ping(port, before=["OK leftover"])(line)
            else:
                port.feed(*VERSION)

        port.on_command = respond
        assert transport.command("version") == "fw=0.1.3 proto=2"
        assert not transport.desynced

    def test_failed_resync_closes_the_connection(self, setup):
        transport, port = setup
        transport.timeout = 0.15
        with pytest.raises(TimeoutError_):
            transport.command("read")
        # The device never answers the ping either.
        with pytest.raises(DisconnectedError, match="resynchron"):
            transport.command("version")
        assert port.closed
        assert port.written[1].startswith("ping ")
        assert "version" not in port.written  # the command itself was not sent
        with pytest.raises(DisconnectedError):
            transport.command("version")

    def test_resync_has_one_overall_budget(self, setup):
        # NEGATIVE: the device keeps sending stale lines but never the pong
        transport, port = setup
        transport.timeout = 0.15
        with pytest.raises(TimeoutError_):
            transport.command("read")
        transport.timeout = 0.4
        stop = threading.Event()

        def flood():
            while not stop.is_set():
                port.feed("OK stale")
                time.sleep(0.05)

        thread = threading.Thread(target=flood, daemon=True)
        thread.start()
        outcome: list[BaseException | None] = []

        def run() -> None:
            try:
                transport.command("version")
                outcome.append(None)
            except BaseException as exc:  # recorded and asserted below
                outcome.append(exc)

        runner = threading.Thread(target=run, daemon=True)
        start = time.monotonic()
        runner.start()
        try:
            # A watchdog join: without the overall budget the resync never
            # ends, and this must report red instead of hanging the suite.
            runner.join(timeout=3.0)
            assert not runner.is_alive(), "resync ignored its overall budget"
            assert time.monotonic() - start < 1.0
            assert len(outcome) == 1
            assert isinstance(outcome[0], DisconnectedError)
            assert "resynchron" in str(outcome[0])
        finally:
            stop.set()
            thread.join(timeout=2.0)

    def test_raw_exchange_resyncs_too(self, setup):
        transport, port = setup
        transport.timeout = 0.15
        with pytest.raises(TimeoutError_):
            transport.command("read")
        port.on_command = lambda line: (
            answer_ping(port, before=["OK stale"])(line)
            if line.startswith("ping")
            else port.feed(*VERSION)
        )
        transport.timeout = 0.5
        assert transport.raw_exchange("version") == VERSION


class TestLineGuards:
    @pytest.mark.parametrize("cmd", ["read\nsubscribe on", "read\r\n", "a\rb"])
    def test_raw_exchange_rejects_cr_lf_before_writing(self, setup, cmd):
        transport, port = setup
        with pytest.raises(InvalidArgumentError, match="CR/LF"):
            transport.raw_exchange(cmd)
        assert port.written == []
        assert not transport.desynced

    def test_command_rejects_cr_lf_before_writing(self, setup):
        transport, port = setup
        with pytest.raises(InvalidArgumentError):
            transport.command("read\nversion")
        assert port.written == []

    def test_overlong_unterminated_device_output_is_bounded(self, setup, caplog):
        # NEGATIVE: a device that streams bytes without ever sending a newline
        transport, port = setup
        limit = transport_module.MAX_DEVICE_LINE_BYTES
        with caplog.at_level(logging.ERROR, logger="tcapi"):
            port.feed_raw("x" * (limit + 10))
            assert wait_for(lambda: transport.desynced)
        assert "too long" in caplog.text
        # The remainder of the runaway line is discarded, then the stream
        # recovers: the next command resyncs and works.
        port.feed_raw("tail of the runaway line\r\n")

        def respond(line):
            if line.startswith("ping"):
                answer_ping(port)(line)
            else:
                port.feed(*VERSION)

        port.on_command = respond
        assert transport.command("version") == "fw=0.1.3 proto=2"
        assert not transport.desynced


class TestSerialisation:
    def test_concurrent_commands_get_their_own_responses(self, setup):
        transport, port = setup
        port.on_command = answer_ping(port)
        results: dict[int, int] = {}
        errors: list[Exception] = []

        def worker(base: int) -> None:
            try:
                for i in range(20):
                    n = base + i
                    data = transport.command(f"ping {n}")
                    results[n] = int(data.removeprefix("pong="))
            except Exception as exc:  # collected for the assertion below
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(b,)) for b in (0, 1000, 2000)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert errors == []
        assert all(k == v for k, v in results.items())
        assert len(results) == 60


class TestDtr:
    def test_open_asserts_dtr(self, monkeypatch):
        opened = {}

        class FakeSerial(FakePort):
            def __init__(self, path, baud, timeout=None):
                super().__init__()
                opened["args"] = (path, baud)
                self.dtr = False
                opened["port"] = self

        monkeypatch.setattr(transport_module.serial, "Serial", FakeSerial)
        transport = Transport.open("/dev/ttyACM0")
        try:
            assert opened["args"] == ("/dev/ttyACM0", transport_module.BAUD_RATE)
            assert opened["port"].dtr is True
        finally:
            transport.close()


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


class TestEvents:
    """The event path: parsed events go to the callback, unknown or
    malformed events are logged as errors and discarded (never delivered,
    never queued as a response)."""

    def test_events_delivered_in_order(self, setup):
        transport, port = setup
        events = []
        transport.set_event_callback(events.append)
        port.feed(INPUT_EVENT, PATTERN_DONE, "! PATTERN_TIMEOUT loops=0")
        assert wait_for(lambda: len(events) == 3)
        assert [type(e).__name__ for e in events] == [
            "InputChangeEvent",
            "PatternDoneEvent",
            "PatternTimeoutEvent",
        ]

    def test_event_interleaved_with_a_response(self, setup):
        transport, port = setup
        events = []
        transport.set_event_callback(events.append)
        port.on_command = lambda _: port.feed(INPUT_EVENT, "OK in=0x00000003")
        assert transport.command("read") == "in=0x00000003"
        assert wait_for(lambda: events == [InputChangeEvent(inputs=1, t_us=5)])

    def test_event_inside_a_counted_response_is_routed_away(self, setup):
        transport, port = setup
        events = []
        transport.set_event_callback(events.append)
        port.on_command = lambda _: port.feed(
            TS_GET_2[0], TS_GET_2[1], INPUT_EVENT, TS_GET_2[2]
        )
        _, lines = transport.command_counted("ts get 10")
        assert lines == TS_GET_2[1:]
        assert wait_for(lambda: len(events) == 1)

    def test_unknown_event_is_logged_and_discarded(self, setup, caplog):
        # NEGATIVE: an event name the protocol does not define
        transport, port = setup
        events = []
        transport.set_event_callback(events.append)
        with caplog.at_level(logging.ERROR, logger="tcapi"):
            port.on_command = lambda _: port.feed(
                "! SYNC_DONE status=ready devnum=1 ts=42", *VERSION
            )
            assert transport.command("version") == "fw=0.1.3 proto=2"
            assert wait_for(
                lambda: any("SYNC_DONE" in r.message for r in caplog.records)
            )
        assert events == []  # never delivered, never a response

    def test_malformed_known_event_is_logged_and_discarded(self, setup, caplog):
        # NEGATIVE: INPUT without t=
        transport, port = setup
        events = []
        transport.set_event_callback(events.append)
        with caplog.at_level(logging.ERROR, logger="tcapi"):
            port.feed("! INPUT in=0x1")
            assert wait_for(lambda: any("INPUT" in r.message for r in caplog.records))
        assert events == []

    def test_events_without_a_subscriber_are_discarded(self, setup):
        transport, port = setup
        port.feed(INPUT_EVENT)
        port.on_command = lambda _: port.feed(*VERSION)
        assert transport.command("version") == "fw=0.1.3 proto=2"

    def test_raising_callback_does_not_kill_the_reader(self, setup, caplog):
        transport, port = setup

        def boom(_event):
            raise RuntimeError("subscriber bug")

        transport.set_event_callback(boom)
        with caplog.at_level(logging.ERROR, logger="tcapi"):
            port.feed(INPUT_EVENT)
            assert wait_for(
                lambda: any(
                    "subscriber bug" in r.exc_text or "callback" in r.message
                    for r in caplog.records
                    if r.exc_text or r.message
                )
            )
        port.on_command = lambda _: port.feed(*VERSION)
        assert transport.command("version") == "fw=0.1.3 proto=2"
