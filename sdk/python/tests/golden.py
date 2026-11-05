"""Golden transcript loader and replay helpers (R-C4).

The transcripts in ``protocol/golden/`` are the single source of truth for
the v2 wire format. Every fake device in this test suite generates its
responses from them: nothing in the tests invents a device response line,
except the explicitly marked malformed-input (negative) tests.

File format: see ``protocol/golden/README.md``. A blank line ends a test
case; ``> `` is a request, ``< OK`` / ``< ERR`` a response header,
``<   `` a continuation line, ``< ! `` an event, ``~ `` a harness directive.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .fake_port import FakePort

GOLDEN_DIR = Path(__file__).resolve().parents[3] / "protocol" / "golden"

GOLDEN_FILES = (
    "version-info",
    "map",
    "io",
    "pattern",
    "timestamp",
    "sync",
    "reset",
    "errors",
    "boundary",
    "events",
    "safety",
)


@dataclass
class Request:
    """A request line and the wire lines the device answers with: the
    header (``OK ...`` / ``ERR NAME``) and any continuation lines
    (two leading spaces, as on the wire)."""

    text: str
    response: list[str] = field(default_factory=list)
    line_no: int = 0


@dataclass
class Directive:
    text: str
    line_no: int = 0


@dataclass
class Event:
    """An asynchronous event; ``wire`` is the line as sent (``! INPUT ...``)."""

    wire: str
    line_no: int = 0


Step = Request | Directive | Event


@dataclass
class Case:
    file: str
    title: str
    steps: list[Step] = field(default_factory=list)
    #: True when the case needs raw (non-text) bytes that a text-line fake
    #: cannot express (binary frames, partial lines).
    binary: bool = False

    @property
    def requests(self) -> list[Request]:
        return [s for s in self.steps if isinstance(s, Request)]

    @property
    def events(self) -> list[Event]:
        return [s for s in self.steps if isinstance(s, Event)]


def _decode_send_hex(args: str) -> tuple[str, str | None]:
    """Classify a ``~ send_hex`` payload: ``("blank", None)`` for bare
    terminators, ``("text", request)`` for a terminated text line,
    ``("binary", None)`` for anything else."""
    data = bytes(int(h, 16) for h in args.split())
    if data and all(b in (0x0D, 0x0A) for b in data):
        return "blank", None
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        return "binary", None
    stripped = text.rstrip("\r\n")
    if text != stripped and stripped[:1].isalpha() and stripped.isprintable():
        return "text", stripped
    return "binary", None


def parse_file(name: str) -> list[Case]:
    path = GOLDEN_DIR / f"{name}.txt"
    lines = path.read_text().split("\n")
    cases: list[Case] = []
    title = ""
    case: Case | None = None
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if line == "":
            case = None
            continue
        if line.startswith("# --- ") and line.endswith(" ---"):
            title = line[6:-4]
            continue
        if line.startswith("# "):
            continue
        if case is None:
            case = Case(file=name, title=title)
            cases.append(case)
        if line.startswith("> "):
            req = Request(text=line[2:], line_no=i)
            case.steps.append(req)
            # Header + continuation lines directly after the request.
            if i < len(lines) and lines[i].startswith(("< OK", "< ERR")):
                req.response.append(lines[i][2:])
                i += 1
                while i < len(lines) and lines[i].startswith("<   "):
                    req.response.append(lines[i][2:])
                    i += 1
        elif line.startswith("< ! "):
            case.steps.append(Event(wire=line[2:], line_no=i))
        elif line.startswith("~ send_hex "):
            kind, text = _decode_send_hex(line[len("~ send_hex ") :])
            if kind == "binary":
                case.binary = True
            elif kind == "text":
                assert text is not None
                req = Request(text=text, line_no=i)
                case.steps.append(req)
                if i < len(lines) and lines[i].startswith(("< OK", "< ERR")):
                    req.response.append(lines[i][2:])
                    i += 1
                    while i < len(lines) and lines[i].startswith("<   "):
                        req.response.append(lines[i][2:])
                        i += 1
        elif line.startswith("~ "):
            case.steps.append(Directive(text=line[2:], line_no=i))
        elif case.binary and line.startswith(("< OK", "< ERR", "<   ")):
            continue  # response to raw bytes of a binary case (not replayable)
        else:
            raise AssertionError(f"{name}.txt:{i}: unrecognised golden line: {line!r}")
    return cases


def load_cases() -> list[Case]:
    cases: list[Case] = []
    for name in GOLDEN_FILES:
        cases.extend(parse_file(name))
    return cases


def find_case(file: str, title_part: str, *, exact: bool = False) -> Case:
    """The single case of ``file`` whose title contains (or, with
    ``exact``, equals) ``title_part``."""
    found = [
        c
        for c in parse_file(file)
        if (c.title == title_part if exact else title_part in c.title)
    ]
    assert len(found) == 1, f"{file}: {len(found)} cases match {title_part!r}"
    return found[0]


def first_response(file: str, request: str) -> list[str]:
    """Response wire lines of the first golden request equal to ``request``."""
    for case in parse_file(file):
        for req in case.requests:
            if req.text == request:
                return req.response
    raise AssertionError(f"{file}: no golden request {request!r}")


def find_request(file: str, prefix: str, header_has: str = "") -> Request:
    """First golden request of ``file`` that starts with ``prefix`` and whose
    response header contains ``header_has``."""
    for case in parse_file(file):
        for req in case.requests:
            if (
                req.text.startswith(prefix)
                and req.response
                and header_has in req.response[0]
            ):
                return req
    raise AssertionError(f"{file}: no golden request {prefix!r} / {header_has!r}")


def canon(request: str) -> tuple:
    """Canonical form of a request for comparison: command words are
    case-insensitive, numbers may be decimal or hex, ``map set`` keys may
    come in any order and a leading ``v=2`` is optional (all allowed by the
    spec, so an SDK may spell them differently from the transcript)."""

    def value(tok: str) -> object:
        try:
            return int(tok, 0)
        except ValueError:
            return tok.lower()

    words = request.split()
    if len(words) >= 2 and words[0].lower() == "map" and words[1].lower() == "set":
        pairs = []
        for tok in words[2:]:
            key, sep, val = tok.partition("=")
            if sep and key.lower() == "v" and val == "2":
                continue
            pairs.append((key.lower(), value(val) if sep else None))
        return ("map", "set", tuple(sorted(pairs, key=lambda p: p[0])))
    return tuple(value(w) for w in words)


class ReplayPort(FakePort):
    """A fake port whose device side replays one golden case.

    Each request the host writes must equal (canonically) the next request
    of the case; the device then answers with the golden response lines.
    Events of the case are pushed right after the response of the request
    that precedes them in the transcript (directives such as ``~ advance``
    take no time here and are skipped). The first request of the
    connection, ``version``, is the SDK handshake (R-U2) and is answered
    from the golden ``version`` response, outside the case.

    Mismatches are collected in :attr:`mismatches` (an assertion inside the
    reader-thread callback would be lost).
    """

    def __init__(self, case: Case | None = None, *, handshake: bool = True) -> None:
        super().__init__()
        self._steps: list[Step] = list(case.steps) if case else []
        self._handshake_pending = handshake
        self._version_response = first_response("version-info", "version")
        self.mismatches: list[str] = []
        self.on_command = self._respond
        self._push_events()  # events that precede the first request

    def _push_events(self) -> None:
        while self._steps and not isinstance(self._steps[0], Request):
            step = self._steps.pop(0)
            if isinstance(step, Event):
                self.feed(step.wire)

    def _respond(self, line: str) -> None:
        if self._handshake_pending and line.strip().lower() == "version":
            self._handshake_pending = False
            self.feed(*self._version_response)
            return
        if not self._steps:
            self.mismatches.append(f"unexpected request {line!r}: case exhausted")
            return
        expected = self._steps.pop(0)
        assert isinstance(expected, Request)
        if canon(line) != canon(expected.text):
            self.mismatches.append(
                f"request {line!r} != golden {expected.text!r} "
                f"(golden line {expected.line_no})"
            )
            return
        self.feed(*expected.response)
        self._push_events()

    @property
    def exhausted(self) -> bool:
        return not self._steps
