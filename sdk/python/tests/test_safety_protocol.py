"""Safety functions: command builders, response parsers, typed errors,
feature bits and the ``! FAILSAFE`` event. Mirrors the safety tests of
``sdk/rust/src/{protocol,error,types}.rs``.

Well-formed lines in the happy-path tests are the shapes of
``protocol/golden/safety.txt``; the lines marked NEGATIVE are hand-written
malformed input."""

from __future__ import annotations

import pytest

from tcapi import protocol
from tcapi.errors import (
    BadParamError,
    BusyError,
    ExclusiveError,
    FailsafeError,
    InvalidArgumentError,
    ParseError,
    SafetyMismatchError,
    SdkError,
    TransportNotSupportedError,
    UnknownCmdError,
    UnknownDeviceError,
    from_error_code,
)
from tcapi.safety import SafetyConfig
from tcapi.types import (
    FEAT_EXCL,
    FEAT_OUTRESET,
    FEAT_PADS,
    FEAT_RESET,
    FEAT_RSTINFO,
    FEAT_SYNC,
    FEAT_USBSAFE,
    FEAT_WDOG,
    FEATURE_MASK,
    MAX_EXCLUSIVE_GROUPS,
    WDOG_MAX_MS,
    WDOG_MIN_MS,
    Capabilities,
    FailsafeCause,
    FailsafeEvent,
    Feature,
    Pads,
    ResetCause,
    ResetInfo,
    SafetyState,
)

# --- constants and feature bits ---


def caps_with(features: int) -> Capabilities:
    return Capabilities(25, 4, 21, 40, 200, 256, 256, features)


def test_safety_constants():
    assert (WDOG_MIN_MS, WDOG_MAX_MS, MAX_EXCLUSIVE_GROUPS) == (100, 10000, 16)


def test_feature_bits_and_constants():
    assert (FEAT_SYNC, FEAT_RESET, FEAT_WDOG, FEAT_EXCL) == (0x01, 0x02, 0x04, 0x08)
    assert (FEAT_OUTRESET, FEAT_RSTINFO, FEAT_USBSAFE, FEAT_PADS) == (
        0x10,
        0x20,
        0x40,
        0x80,
    )
    assert FEATURE_MASK == 0xFF
    # Iteration order is bit order.
    assert [f.bit for f in Feature] == [1 << n for n in range(8)]
    assert [f.name for f in Feature] == [
        "SYNC",
        "RESET",
        "WDOG",
        "EXCL",
        "OUTRESET",
        "RSTINFO",
        "USBSAFE",
        "PADS",
    ]


def test_has_and_feature_list():
    caps = caps_with(FEAT_WDOG | FEAT_PADS)
    assert caps.has(Feature.WDOG) and caps.has(Feature.PADS)
    assert not caps.has(Feature.SYNC) and not caps.has(Feature.EXCL)
    assert caps.feature_list() == [Feature.WDOG, Feature.PADS]
    assert caps_with(0).feature_list() == []
    assert caps_with(0xFF).feature_list() == list(Feature)
    # The older helpers agree with `has`.
    assert caps_with(FEAT_SYNC).has_sync() and not caps_with(FEAT_SYNC).has_reset()
    assert caps_with(FEAT_RESET).has_reset() and not caps_with(FEAT_RESET).has_sync()


def test_undefined_feature_bits_are_not_listed():
    assert caps_with(0x100 | FEAT_EXCL).feature_list() == [Feature.EXCL]


# --- command builders ---


def test_wdog_command_accepts_zero_and_the_documented_range():
    assert protocol.wdog_command(0) == "wdog 0"
    assert protocol.wdog_command(100) == "wdog 100"
    assert protocol.wdog_command(10_000) == "wdog 10000"


@pytest.mark.parametrize("bad", [1, 99, 10_001, 0xFFFFFFFF, -1])
def test_wdog_command_refuses_out_of_range(bad):
    with pytest.raises(InvalidArgumentError):
        protocol.wdog_command(bad)


def test_usbsafe_command():
    assert protocol.usbsafe_command(True) == "usbsafe on"
    assert protocol.usbsafe_command(False) == "usbsafe off"


def test_excl_set_command_spells_masks_in_hex():
    assert protocol.excl_set_command([0xC]) == "excl set 0xc"
    assert protocol.excl_set_command([0xC, 0x18]) == "excl set 0xc 0x18"
    sixteen = protocol.excl_set_command([0x3] * 16)
    assert sixteen.count("0x3") == 16


def test_excl_set_command_checks_groups_before_sending():
    for bad_list in ([], [0x3] * 17):
        with pytest.raises(InvalidArgumentError):
            protocol.excl_set_command(bad_list)
    # Fewer than two pins, outside the DIO pins, negative, not a u32.
    for bad in (0, 0x1, 0x8000_0000, 0x0080_0003, 0x1000_0003, -3, 1 << 32):
        with pytest.raises(InvalidArgumentError):
            protocol.excl_set_command([bad])
    with pytest.raises(InvalidArgumentError, match="group 1"):
        protocol.excl_set_command([0x3, 0x1])


# --- safety ---


def test_safety_state_parses_every_golden_shape():
    st = protocol.parse_safety(
        "wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0"
    )
    assert st == SafetyState(0, 0, False, FailsafeCause.NONE, False, 0)
    st = protocol.parse_safety(
        "wdog_ms=500 remaining_ms=377 failsafe=0 cause=none usbsafe=1 excl=16"
    )
    assert (st.wdog_ms, st.remaining_ms, st.usbsafe, st.excl) == (500, 377, True, 16)
    st = protocol.parse_safety(
        "wdog_ms=100 remaining_ms=0 failsafe=1 cause=wdog usbsafe=0 excl=0"
    )
    assert st.failsafe and st.cause is FailsafeCause.WDOG
    st = protocol.parse_safety(
        "wdog_ms=0 remaining_ms=0 failsafe=1 cause=usb usbsafe=1 excl=0"
    )
    assert st.cause is FailsafeCause.USB


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0",
        "wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0 extra=1",
        "wdog_ms=x remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0",
        "wdog_ms=0 remaining_ms=0 failsafe=2 cause=none usbsafe=0 excl=0",
        "wdog_ms=0 remaining_ms=0 failsafe=0 cause=other usbsafe=0 excl=0",
        "wdog_ms=0 remaining_ms=0 failsafe=0 cause=NONE usbsafe=0 excl=0",
        "wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=17",
        "wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=256",
        "wdog_ms=4294967296 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0",
        # The latch and its cause must agree.
        "wdog_ms=0 remaining_ms=0 failsafe=1 cause=none usbsafe=0 excl=0",
        "wdog_ms=0 remaining_ms=0 failsafe=0 cause=wdog usbsafe=0 excl=0",
    ],
)
def test_safety_state_rejects_malformed_responses_NEGATIVE(bad):
    with pytest.raises(ParseError):
        protocol.parse_safety(bad)


# --- rstinfo ---


@pytest.mark.parametrize(
    "name,cause",
    [
        ("por", ResetCause.POR),
        ("wdt", ResetCause.WDT),
        ("soft", ResetCause.SOFT),
        ("bor", ResetCause.BOR),
        ("other", ResetCause.OTHER),
    ],
)
def test_rstinfo_parses_every_cause(name, cause):
    info = protocol.parse_rstinfo(f"cause={name} uptime_ms=5000 boot=0x00000002")
    assert info == ResetInfo(cause=cause, uptime_ms=5000, boot=2)


def test_rstinfo_uptime_is_64_bit():
    info = protocol.parse_rstinfo("cause=por uptime_ms=18446744073709551615 boot=0x1")
    assert info.uptime_ms == 0xFFFFFFFFFFFFFFFF


@pytest.mark.parametrize(
    "bad",
    [
        "cause=reset uptime_ms=0 boot=0x1",
        "cause=por uptime_ms=-1 boot=0x1",
        "cause=por uptime_ms=18446744073709551616 boot=0x1",
        "cause=por uptime_ms=0",
        "cause=por uptime_ms=0 boot=zz",
        "cause=por uptime_ms=0 boot=0x100000000",
        "cause=por uptime_ms=0 boot=0x1 more=1",
    ],
)
def test_rstinfo_rejects_malformed_responses_NEGATIVE(bad):
    with pytest.raises(ParseError):
        protocol.parse_rstinfo(bad)


# --- pads ---


def test_pads_parse_with_free_key_order():
    assert protocol.parse_pads("out=0x00000005 pad=0x00000001") == Pads(5, 1)
    assert protocol.parse_pads("pad=0x2 out=0x4") == Pads(out=4, pad=2)


@pytest.mark.parametrize(
    "bad", ["out=0x5", "out=0x5 pad=zz", "pad=0x1 out=0x5 x=1", "", "out=0x1 pad=-1"]
)
def test_pads_reject_malformed_responses_NEGATIVE(bad):
    with pytest.raises(ParseError):
        protocol.parse_pads(bad)


# --- excl get (counted) ---


def test_excl_get_reads_the_counted_masks_in_order():
    masks = protocol.parse_excl_get(
        "count=2", ["  mask=0x0000000c", "  mask=0x00000018"]
    )
    assert masks == [0xC, 0x18]
    assert protocol.parse_excl_get("count=0", []) == []


@pytest.mark.parametrize(
    "header,lines",
    [
        ("count=2", ["  mask=0x3"]),
        ("count=0", ["  mask=0x3"]),
        ("count=17", []),
        ("count=x", []),
        ("count=1", ["  mask=zz"]),
        ("count=1", ["  bits=0x3"]),
        ("count=1 overflow=0", ["  mask=0x3"]),
        ("", []),
    ],
)
def test_excl_get_rejects_inconsistent_responses_NEGATIVE(header, lines):
    with pytest.raises(ParseError):
        protocol.parse_excl_get(header, lines)


# --- ! FAILSAFE event ---


def test_push_failsafe_event():
    assert protocol.parse_push_event("FAILSAFE cause=wdog") == FailsafeEvent(
        FailsafeCause.WDOG
    )
    assert protocol.parse_push_event("FAILSAFE cause=usb") == FailsafeEvent(
        FailsafeCause.USB
    )


@pytest.mark.parametrize(
    "bad",
    [
        "FAILSAFE",
        "FAILSAFE cause=none",
        "FAILSAFE cause=disk",
        "FAILSAFE cause=wdog x=1",
    ],
)
def test_push_failsafe_event_rejects_malformed_NEGATIVE(bad):
    with pytest.raises(ParseError):
        protocol.parse_push_event(bad)


# --- typed errors ---


def test_failsafe_and_transport_codes_are_typed():
    err = from_error_code("FAILSAFE")
    assert isinstance(err, FailsafeError) and err.code == "FAILSAFE"
    assert str(err) == "device error: FAILSAFE (failsafe latch is set)"
    assert isinstance(
        from_error_code("TRANSPORT_NOT_SUPPORTED"), TransportNotSupportedError
    )


def test_exclusive_carries_group_and_mask():
    err = from_error_code("EXCLUSIVE group=1 mask=0x0000000c")
    assert isinstance(err, ExclusiveError) and err.code == "EXCLUSIVE"
    assert (err.group, err.mask) == (1, 0xC)
    assert (
        str(from_error_code("EXCLUSIVE group=0 mask=0x0000000c"))
        == "device error: EXCLUSIVE (exclusive group 0 would be violated, mask 0x0000000c)"
    )
    # Token order is free, further key=value tokens are tolerated, mask may be decimal.
    err = from_error_code("EXCLUSIVE mask=0x7 extra=zz group=15 more=1")
    assert (err.group, err.mask) == (15, 7)
    err = from_error_code("EXCLUSIVE group=2 mask=12")
    assert (err.group, err.mask) == (2, 12)
    err = from_error_code("EXCLUSIVE group=255 mask=0xffffffff")
    assert (err.group, err.mask) == (255, 0xFFFFFFFF)


@pytest.mark.parametrize(
    "bad",
    [
        "EXCLUSIVE",
        "EXCLUSIVE group=0",
        "EXCLUSIVE mask=0x3",
        "EXCLUSIVE group=x mask=0x3",
        "EXCLUSIVE group=256 mask=0x3",
        "EXCLUSIVE group=-1 mask=0x3",
        "EXCLUSIVE group=+1 mask=0x3",
        "EXCLUSIVE group=0 mask=zz",
        "EXCLUSIVE group=0 mask=0x100000000",
        "EXCLUSIVE group=0 mask=-3",
    ],
)
def test_exclusive_without_valid_data_is_a_parse_error_not_a_default(bad):
    err = from_error_code(bad)
    assert isinstance(err, ParseError)
    assert not isinstance(err, ExclusiveError)


def test_data_tokens_after_a_plain_name_are_ignored():
    assert isinstance(from_error_code("BUSY detail=1"), BusyError)
    assert isinstance(from_error_code("FAILSAFE cause=wdog"), FailsafeError)
    assert isinstance(from_error_code("BAD_PARAM x=1 y=2"), BadParamError)
    assert isinstance(from_error_code("UNKNOWN_CMD later=1"), UnknownCmdError)


def test_unknown_names_keep_the_whole_text():
    err = from_error_code("NEW_ERR a=1")
    assert isinstance(err, UnknownDeviceError)
    assert str(err) == "device error: NEW_ERR a=1"


def test_names_are_case_sensitive_and_exact():
    assert isinstance(from_error_code("failsafe"), UnknownDeviceError)
    assert isinstance(from_error_code(""), UnknownDeviceError)


def test_safety_mismatch_error_is_an_sdk_error():
    err = SafetyMismatchError("wdog_ms is 1, expected 2")
    assert isinstance(err, SdkError) and err.code == "SAFETY_MISMATCH"
    assert "wdog_ms is 1, expected 2" in str(err)


# --- SafetyConfig ---


def test_config_commands_follow_the_dd16_order():
    cfg = SafetyConfig(watchdog_ms=800, usbsafe=True, groups=[0xC, 0x18])
    assert cfg.commands() == ["excl set 0xc 0x18", "usbsafe on", "wdog 800"]


def test_config_without_groups_clears_them_and_never_sets():
    assert SafetyConfig().commands() == ["excl clear", "usbsafe off", "wdog 0"]


@pytest.mark.parametrize(
    "bad",
    [
        SafetyConfig(watchdog_ms=50),
        SafetyConfig(watchdog_ms=10_001),
        SafetyConfig(groups=[0x1]),
        SafetyConfig(groups=[0x3] * 17),
        SafetyConfig(groups=[0x8000_0003]),
    ],
)
def test_config_commands_refuse_values_the_device_would_refuse(bad):
    with pytest.raises(InvalidArgumentError):
        bad.commands()


def test_config_default_groups_are_not_shared_between_instances():
    a, b = SafetyConfig(), SafetyConfig()
    a.groups.append(0x3)
    assert b.groups == []


def state(**kw) -> SafetyState:
    base = {
        "wdog_ms": 800,
        "remaining_ms": 800,
        "failsafe": False,
        "cause": FailsafeCause.NONE,
        "usbsafe": True,
        "excl": 2,
    }
    base.update(kw)
    return SafetyState(**base)


FULL = SafetyConfig(watchdog_ms=800, usbsafe=True, groups=[0xC, 0x18])


def test_no_differences_when_the_read_back_equals_the_file():
    assert FULL.differences(state(), [0xC, 0x18]) == []


def test_the_latch_and_remaining_time_are_not_compared():
    latched = state(failsafe=True, cause=FailsafeCause.WDOG, remaining_ms=0)
    assert FULL.differences(latched, [0xC, 0x18]) == []


def test_every_difference_is_listed():
    diffs = FULL.differences(state(wdog_ms=801), [0xC | 0x100, 0x18])
    assert diffs == [
        "wdog_ms is 801, expected 800",
        "group 0 is 0x0000010c, expected 0x0000000c",
    ]
    assert FULL.differences(state(usbsafe=False), [0xC, 0x18]) == [
        "usbsafe is 0, expected 1"
    ]
    assert FULL.differences(state(excl=1), [0xC, 0x18]) == ["excl is 1, expected 2"]


def test_excl_get_with_extra_or_missing_groups_is_a_difference():
    assert FULL.differences(state(), [0xC, 0x18, 0x3]) == [
        "excl get returned 3 groups, expected 2"
    ]
    assert FULL.differences(state(), [0xC]) == [
        "excl get returned 1 groups, expected 2"
    ]
