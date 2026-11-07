"""Parser for the host-side TOML file ``safety.toml`` (schema v2,
``docs/config-files.md``, R-TOML1/R-TOML2). Mirrors ``parse_safety`` /
``load_safety`` of ``sdk/rust/src/config.rs``.

There is no lenient mode: a ``version`` other than 2, an unknown key or a
contradictory setting is an error, and every error names the file and the
1-based line of the offending element (``<file>:<line>: <message>``). The
message texts are the ones of section 4 of the document; the shared fixtures
in ``docs/fixtures/`` pin them down for every implementation.

Exactly one error is reported: the first failing check, in the order the
document defines (syntax, ``version``, unknown top-level keys, then the
sections ``watchdog``, ``usb`` and ``exclusive``).
"""

from __future__ import annotations

import re
import sys
from os import PathLike
from typing import Any

from .errors import IoError, ParseError
from .safety import SafetyConfig
from .types import (
    MAX_EXCLUSIVE_GROUPS,
    PROTO_VERSION,
    VALID_DIO_MASK,
    WDOG_MAX_MS,
    WDOG_MIN_MS,
)

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised on Python 3.10 only
    import tomli as tomllib

_PIN_DIGITS = re.compile(r"[1-9][0-9]*|0")
_SYNTAX_LINE = re.compile(r"\(at line (\d+), column \d+\)")


class ConfigError(ParseError):
    """A rejected configuration file. ``str()`` is
    ``<file>:<line>: <message>``; unlike the other SDK errors, ``message`` is
    the bare message of ``docs/config-files.md`` section 4, without the
    prefix. It is a :class:`~pochi.errors.ParseError`."""

    def __init__(self, file: str, line: int, message: str) -> None:
        super().__init__(f"{file}:{line}: {message}")
        #: Name of the file as given to the parser (used in the text only).
        self.file = file
        #: 1-based line of the offending element.
        self.line = line
        #: The message of ``docs/config-files.md`` section 4, without prefix.
        self.message = message


def parse_safety(src: str, file: str) -> SafetyConfig:
    """Parse the text of a ``safety.toml`` into the settings it declares: the
    watchdog timeout, ``usbsafe`` and one pin mask per exclusive group.
    ``file`` only labels errors. Applying the result is
    :meth:`pochi.Connection.apply_safety`."""
    try:
        return _SafetyEvaluator(src).evaluate()
    except _Fail as fail:
        raise ConfigError(file, fail.line, fail.message) from None


def load_safety(path: str | PathLike[str]) -> SafetyConfig:
    """Read and parse a ``safety.toml``. Errors carry the path of the file;
    a file that cannot be read (or is not UTF-8) is an
    :class:`~pochi.errors.IoError`."""
    try:
        with open(path, encoding="utf-8") as handle:
            src = handle.read()
    except (OSError, UnicodeDecodeError) as exc:
        raise IoError(f"failed to read {path}: {exc}") from exc
    return parse_safety(src, str(path))


# ------------------------------------------------------------------ errors


class _Fail(Exception):
    """An error before the file name is attached."""

    def __init__(self, message: str, line: int) -> None:
        super().__init__(message)
        self.message = message
        self.line = line


class _Source:
    """The source text, for mapping an element to its line. The parsed value
    tree carries no positions, so the line is found by scanning for the key,
    exactly as the Rust reference does."""

    def __init__(self, src: str) -> None:
        # Not `str.splitlines()`: it also breaks at form feeds and Unicode
        # separators, which TOML does not.
        self.lines = src.split("\n")

    @staticmethod
    def _is_code(line: str) -> bool:
        stripped = line.lstrip()
        return bool(stripped) and not stripped.startswith("#")

    def _key_line(self, name: str) -> int | None:
        """Index of the line with ``name`` as a key (``name = ...``,
        ``"name" = ...``, ``name.sub = ...``) or as a table header
        (``[name]``, ``[[name]]``)."""
        tables = (f"[{name}]", f"[[{name}]]")
        for i, line in enumerate(self.lines):
            if not self._is_code(line):
                continue
            text = line.strip()
            if text in tables:
                return i
            text = text.lstrip('"')
            if text.startswith(name):
                rest = text[len(name) :].lstrip('"')
                if rest[:1] in (" ", "\t", "=", "."):
                    return i
        return None

    def _nth_header(self, header: str, n: int) -> int | None:
        """Index of the ``n``-th (1-based) line that is exactly ``header``."""
        found = 0
        for i, line in enumerate(self.lines):
            if line.strip() == header:
                found += 1
                if found == n:
                    return i
        return None

    def _key_in_section(self, header: int, key: str) -> int:
        """Index of ``key`` in the section whose header is at ``header``;
        ``header`` itself if the key is absent."""
        for i in range(header + 1, len(self.lines)):
            line = self.lines[i]
            stripped = line.lstrip()
            if stripped.startswith("["):
                break
            if (
                self._is_code(line)
                and stripped.startswith(key)
                and stripped[len(key) :][:1] in (" ", "\t", "=")
            ):
                return i
        return header

    # --- locations (1-based result) ---

    def file(self) -> int:
        return 1

    def key(self, name: str) -> int:
        found = self._key_line(name)
        return 1 if found is None else found + 1

    def field(self, table: str, key: str) -> int:
        """Key ``key`` of the ``[table]`` section (or of the inline table
        ``table = {...}``); the section header if the key is absent."""
        header = self._nth_header(f"[{table}]", 1)
        if header is not None:
            return self._key_in_section(header, key) + 1
        return self.key(table)

    def group(self, n: int) -> int:
        """The header of exclusive group ``n`` (1-based ``[[exclusive]]``)."""
        header = self._nth_header("[[exclusive]]", n)
        return header + 1 if header is not None else self.key("exclusive")

    def group_key(self, n: int, key: str) -> int:
        """Key ``key`` inside exclusive group ``n``; the group header if the
        key is absent."""
        header = self._nth_header("[[exclusive]]", n)
        if header is not None:
            return self._key_in_section(header, key) + 1
        return self.key("exclusive")

    def fail(self, line: int, message: str) -> _Fail:
        return _Fail(message, line)


# ------------------------------------------------------------------ helpers


def _is_integer(value: Any) -> bool:
    # `bool` is an `int` in Python; the file format distinguishes them.
    return isinstance(value, int) and not isinstance(value, bool)


def _pin_number(name: str) -> int | None:
    """Canonical pin name grammar ``GP(0|[1-9][0-9]*)`` whose number is in
    ``VALID_DIO_MASK``."""
    if not name.startswith("GP"):
        return None
    digits = name[2:]
    if not _PIN_DIGITS.fullmatch(digits):
        return None
    n = int(digits)
    return n if n < 32 and VALID_DIO_MASK & (1 << n) else None


def _syntax_error(src: str, exc: tomllib.TOMLDecodeError) -> _Fail:
    text = str(exc)
    match = _SYNTAX_LINE.search(text)
    # "at end of document" has no line: it is the last one.
    line = int(match.group(1)) if match else src.count("\n") + 1
    return _Fail(f"toml syntax: {text}", line)


class _SafetyEvaluator:
    def __init__(self, src: str) -> None:
        # A leading UTF-8 byte order mark (Windows editors write one) is
        # accepted, as by the Rust reference and the other SDKs; `tomllib`
        # would reject it as a syntax error. Line numbers are unchanged.
        src = src.removeprefix("﻿")
        self.src = src
        self.where = _Source(src)

    def evaluate(self) -> SafetyConfig:
        try:
            table = tomllib.loads(self.src)
        except tomllib.TOMLDecodeError as exc:
            raise _syntax_error(self.src, exc) from None
        self._check_version(table)
        self._check_keys(table, ("version", "watchdog", "usb", "exclusive"))
        watchdog_ms = self._watchdog(table)
        usbsafe = self._usb(table)
        groups = self._exclusive(table)
        return SafetyConfig(watchdog_ms=watchdog_ms, usbsafe=usbsafe, groups=groups)

    def _fail(self, line: int, message: str) -> _Fail:
        return self.where.fail(line, message)

    def _check_version(self, table: dict[str, Any]) -> None:
        if "version" not in table:
            raise self._fail(self.where.file(), 'missing key "version"')
        version = table["version"]
        line = self.where.key("version")
        if not _is_integer(version):
            raise self._fail(line, "version must be an integer")
        if version != PROTO_VERSION:
            raise self._fail(
                line, f"unsupported version: expected {PROTO_VERSION}, got {version}"
            )

    def _check_keys(self, table: dict[str, Any], allowed: tuple[str, ...]) -> None:
        # Sorted like the reference's ordered map: which of several unknown
        # keys is reported does not depend on the file order.
        for key in sorted(table):
            if key not in allowed:
                raise self._fail(self.where.key(key), f'unknown key "{key}"')

    def _check_table_keys(
        self, table: dict[str, Any], allowed: tuple[str, ...], name: str
    ) -> None:
        for key in sorted(table):
            if key not in allowed:
                raise self._fail(
                    self.where.field(name, key), f'unknown key "{key}" in {name}'
                )

    def _watchdog(self, table: dict[str, Any]) -> int:
        if "watchdog" not in table:
            return 0
        section = table["watchdog"]
        if not isinstance(section, dict):
            raise self._fail(self.where.key("watchdog"), "watchdog must be a table")
        self._check_table_keys(section, ("timeout_ms",), "watchdog")
        if "timeout_ms" not in section:
            return 0
        line = self.where.field("watchdog", "timeout_ms")
        ms = section["timeout_ms"]
        if not _is_integer(ms):
            raise self._fail(line, "watchdog.timeout_ms must be an integer")
        if ms != 0 and not WDOG_MIN_MS <= ms <= WDOG_MAX_MS:
            raise self._fail(
                line,
                f"watchdog.timeout_ms must be 0 or between {WDOG_MIN_MS} and {WDOG_MAX_MS}",
            )
        return ms

    def _usb(self, table: dict[str, Any]) -> bool:
        if "usb" not in table:
            return False
        section = table["usb"]
        if not isinstance(section, dict):
            raise self._fail(self.where.key("usb"), "usb must be a table")
        self._check_table_keys(section, ("safe",), "usb")
        if "safe" not in section:
            return False
        safe = section["safe"]
        if not isinstance(safe, bool):
            raise self._fail(
                self.where.field("usb", "safe"), "usb.safe must be a boolean"
            )
        return safe

    def _exclusive(self, table: dict[str, Any]) -> list[int]:
        if "exclusive" not in table:
            return []
        entries = table["exclusive"]
        if not isinstance(entries, list):
            raise self._fail(
                self.where.key("exclusive"), "exclusive must be an array of tables"
            )
        # Checked before any group, so 17 groups are always reported as too
        # many even if one of them is also faulty.
        if len(entries) > MAX_EXCLUSIVE_GROUPS:
            raise self._fail(
                self.where.group(MAX_EXCLUSIVE_GROUPS + 1),
                f"too many exclusive groups: {len(entries)} (at most {MAX_EXCLUSIVE_GROUPS})",
            )
        return [self._group(i + 1, entry) for i, entry in enumerate(entries)]

    def _group(self, n: int, entry: Any) -> int:
        """The pin mask of exclusive group ``n`` (1-based)."""
        where = self.where
        if not isinstance(entry, dict):
            raise self._fail(where.group(n), f"exclusive group {n}: must be a table")
        for key in sorted(entry):
            if key != "pins":
                raise self._fail(
                    where.group_key(n, key),
                    f'unknown key "{key}" in exclusive group {n}',
                )
        if "pins" not in entry:
            raise self._fail(where.group(n), f"exclusive group {n}: pins is required")
        line = where.group_key(n, "pins")
        not_names = f"exclusive group {n}: pins must be an array of pin names"
        pins = entry["pins"]
        if not isinstance(pins, list):
            raise self._fail(line, not_names)
        mask = 0
        for pin in pins:
            if not isinstance(pin, str):
                raise self._fail(line, not_names)
            bit = _pin_number(pin)
            if bit is None:
                raise self._fail(
                    line, f'exclusive group {n}: invalid pin "{pin}" in pins'
                )
            if mask & (1 << bit):
                raise self._fail(
                    line, f'exclusive group {n}: duplicate pin "{pin}" in pins'
                )
            mask |= 1 << bit
        if mask.bit_count() < 2:
            raise self._fail(
                line, f"exclusive group {n}: a group needs at least 2 pins"
            )
        return mask
