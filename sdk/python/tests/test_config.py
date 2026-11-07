"""``pochi.config`` (``safety.toml``) against every shared fixture in
``docs/fixtures/`` (R-TOML1/R-TOML2): the evaluated settings, the apply
commands, the exact error message and the reported line must equal the
fixture's ``# expected*`` comments. Mirrors ``sdk/rust/tests/config_fixtures.rs``
for the ``safety-*`` files."""

from __future__ import annotations

from pathlib import Path

import pytest

from pochi import config
from pochi.errors import IoError, ParseError, SdkError
from pochi.safety import SafetyConfig

FIXTURES = Path(__file__).resolve().parents[3] / "docs" / "fixtures"


def safety_fixture_names() -> list[str]:
    return sorted(p.name for p in FIXTURES.glob("safety-*.toml"))


def annotations(src: str, key: str) -> list[str]:
    prefix = f"# {key}:"
    return [
        line[len(prefix) :].strip()
        for line in src.split("\n")
        if line.startswith(prefix)
    ]


def summary(cfg: SafetyConfig) -> str:
    groups = ",".join(f"0x{m:08x}" for m in cfg.groups) if cfg.groups else "none"
    return f"watchdog_ms={cfg.watchdog_ms} usbsafe={int(cfg.usbsafe)} groups={groups}"


def test_the_whole_safety_fixture_set_is_present():
    names = safety_fixture_names()
    assert len(names) >= 38, "safety fixture set looks truncated"


@pytest.mark.parametrize("name", safety_fixture_names())
def test_every_safety_fixture_gives_the_documented_result(name):
    src = (FIXTURES / name).read_text(encoding="utf-8")
    exact = annotations(src, "expected_error")
    prefix = annotations(src, "expected_error_prefix")
    if not exact and not prefix:
        cfg = config.parse_safety(src, name)
        assert annotations(src, "expected") == [summary(cfg)], name
        # DD-16: the apply order of the evaluated file.
        assert cfg.commands() == annotations(src, "expected_command"), name
        return
    assert len(exact) + len(prefix) == 1, f"{name}: one error annotation only"
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety(src, name)
    err = info.value
    if exact:
        assert err.message == exact[0], name
    else:
        assert err.message.startswith(prefix[0]), f"{name}: {err.message}"
    assert err.line == int(annotations(src, "expected_line")[0]), f"{name}: line"
    assert err.file == name
    assert str(err) == f"{name}:{err.line}: {err.message}"


def test_a_config_error_is_a_parse_error_of_the_sdk():
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety("version = 1\n", "s.toml")
    assert isinstance(info.value, ParseError)
    assert isinstance(info.value, SdkError)
    assert info.value.code == "PARSE"


def test_a_file_with_only_the_version_is_the_all_off_default():
    cfg = config.parse_safety("version = 2\n", "s.toml")
    assert cfg == SafetyConfig()
    assert cfg == SafetyConfig(watchdog_ms=0, usbsafe=False, groups=[])


def test_empty_input_is_an_error_not_a_default():
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety("", "s.toml")
    assert (info.value.message, info.value.line) == ('missing key "version"', 1)


def test_booleans_are_not_integers():
    # `True` is an int in Python; the file format distinguishes them.
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety("version = true\n", "s.toml")
    assert info.value.message == "version must be an integer"
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety("version = 2\n[watchdog]\ntimeout_ms = true\n", "s.toml")
    assert info.value.message == "watchdog.timeout_ms must be an integer"
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety("version = 2\n[usb]\nsafe = 1\n", "s.toml")
    assert info.value.message == "usb.safe must be a boolean"


def test_a_float_timeout_is_not_an_integer():
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety("version = 2\n[watchdog]\ntimeout_ms = 100.0\n", "s.toml")
    assert info.value.message == "watchdog.timeout_ms must be an integer"


def test_crlf_line_endings_report_the_same_lines():
    src = "version = 2\r\n\r\n[watchdog]\r\ntimeout = 5\r\n"
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety(src, "s.toml")
    assert info.value.message == 'unknown key "timeout" in watchdog'
    assert info.value.line == 4


def test_a_leading_byte_order_mark_is_accepted_like_the_rust_reference():
    cfg = config.parse_safety("﻿version = 2\n[watchdog]\ntimeout_ms = 500\n", "s.toml")
    assert cfg == SafetyConfig(watchdog_ms=500, usbsafe=False, groups=[])
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety("﻿version = 2\n[watchdog]\ntimeout = 5\n", "s.toml")
    assert info.value.message == 'unknown key "timeout" in watchdog'
    assert info.value.line == 3


def test_load_safety_accepts_a_file_written_with_a_byte_order_mark(tmp_path):
    path = tmp_path / "safety.toml"
    path.write_bytes(b"\xef\xbb\xbfversion = 2\n[usb]\nsafe = true\n")
    assert config.load_safety(path) == SafetyConfig(usbsafe=True)


def test_non_ascii_digits_in_a_pin_name_are_invalid():
    src = 'version = 2\n[[exclusive]]\npins = ["GP١", "GP3"]\n'
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety(src, "s.toml")
    assert info.value.message == 'exclusive group 1: invalid pin "GP١" in pins'


def test_seventeen_groups_are_reported_before_a_fault_inside_one():
    groups = (
        "[[exclusive]]\npins = ['GP1']\n"
        + "[[exclusive]]\npins = ['GP1', 'GP2']\n" * 16
    )
    with pytest.raises(config.ConfigError) as info:
        config.parse_safety("version = 2\n" + groups, "s.toml")
    assert info.value.message == "too many exclusive groups: 17 (at most 16)"


def test_load_safety_reads_a_file_and_labels_errors_with_its_path(tmp_path):
    good = tmp_path / "safety.toml"
    good.write_text("version = 2\n[usb]\nsafe = true\n", encoding="utf-8")
    assert config.load_safety(good) == SafetyConfig(usbsafe=True)
    assert config.load_safety(str(good)) == SafetyConfig(usbsafe=True)

    bad = tmp_path / "bad.toml"
    bad.write_text("version = 3\n", encoding="utf-8")
    with pytest.raises(config.ConfigError) as info:
        config.load_safety(bad)
    assert str(info.value) == f"{bad}:1: unsupported version: expected 2, got 3"


def test_load_safety_reports_a_missing_or_undecodable_file_as_io_error(tmp_path):
    with pytest.raises(IoError):
        config.load_safety(tmp_path / "absent.toml")
    garbage = tmp_path / "garbage.toml"
    garbage.write_bytes(b"version = 2\n\xff\xfe\n")
    with pytest.raises(IoError):
        config.load_safety(garbage)
