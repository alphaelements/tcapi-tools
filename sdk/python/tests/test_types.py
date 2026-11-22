"""v2 types and the channel / pin convention (REF-V2 sections 2 and 4.2)."""

import dataclasses
import json

import pytest

import tcapi
from tcapi.errors import InvalidArgumentError, ParseError
from tcapi.types import (
    DIO_CHANNELS,
    FEAT_RESET,
    FEAT_SYNC,
    PATTERN_TICK_NS,
    PROTO_VERSION,
    VALID_DIO_MASK,
    Capabilities,
    PatternStep,
    PinMap,
    TimestampEvent,
    TimestampResult,
    VersionInfo,
    ch_to_gp,
    gp_to_ch,
    hold_ticks_from_ns,
    pin_label,
)

# --- pin convention (R-PIN1 / R-PIN2) ---


def test_constants():
    assert PROTO_VERSION == 2
    assert VALID_DIO_MASK == 0x0C7FFFFF
    assert bin(VALID_DIO_MASK).count("1") == 25
    assert DIO_CHANNELS == 25
    assert PATTERN_TICK_NS == 200
    for gp in (23, 24, 25, 28, 29, 30, 31):
        assert VALID_DIO_MASK & (1 << gp) == 0


def test_ch_to_gp_identity_for_ch0_to_ch22():
    assert [ch_to_gp(ch) for ch in range(23)] == list(range(23))


def test_ch23_ch24_map_to_gp26_gp27():
    assert ch_to_gp(23) == 26
    assert ch_to_gp(24) == 27


@pytest.mark.parametrize("ch", [-1, 25, 255])
def test_ch_to_gp_rejects_out_of_range(ch):
    with pytest.raises(InvalidArgumentError):
        ch_to_gp(ch)


def test_gp_to_ch_inverts_ch_to_gp():
    for ch in range(DIO_CHANNELS):
        assert gp_to_ch(ch_to_gp(ch)) == ch


@pytest.mark.parametrize("gp", [23, 24, 25, 28, 29, 31, 32, -1])
def test_gp_to_ch_rejects_non_dio_pins(gp):
    with pytest.raises(InvalidArgumentError):
        gp_to_ch(gp)


def test_pin_label():
    assert pin_label(0) == "GP0 (ch0)"
    assert pin_label(22) == "GP22 (ch22)"
    assert pin_label(26) == "GP26 (ch23)"
    assert pin_label(27) == "GP27 (ch24)"
    with pytest.raises(InvalidArgumentError):
        pin_label(25)


def test_exported_from_package():
    assert tcapi.ch_to_gp is ch_to_gp
    assert tcapi.gp_to_ch is gp_to_ch
    assert tcapi.pin_label is pin_label
    assert tcapi.VALID_DIO_MASK == VALID_DIO_MASK
    assert tcapi.PinMap is PinMap


# --- removed v1 surface (R-U1) ---


@pytest.mark.parametrize(
    "name",
    ["PinMapV2", "PullMode", "SyncDoneEvent", "SyncTimeoutError", "channel_to_gp"],
)
def test_v1_names_are_gone(name):
    assert not hasattr(tcapi, name)
    assert not hasattr(tcapi.types, name)
    assert not hasattr(tcapi.errors, name)


def test_no_tachyon_anywhere_in_the_package():
    from pathlib import Path

    src = Path(tcapi.__file__).parent
    for path in src.glob("*.py"):
        assert "tachyon" not in path.read_text().lower(), path.name


# --- PinMap (R-M1) ---


def base_map(**kw) -> PinMap:
    # dir=GP0-GP3 outputs; everything else input.
    fields = dict(
        flags=0,
        direction=0x0000000F,
        pull_up=0x000000F0,
        pull_down=0x0C7FFF00,
        out_default=0x00000005,
        out_polarity=0x00000008,
        in_polarity=0x00000100,
        edge=0x0C7FFFF0,
    )
    fields.update(kw)
    return PinMap(**fields)


def rejects(pin_map: PinMap, field: str):
    with pytest.raises(InvalidArgumentError, match=field):
        pin_map.validate()


def test_pinmap_has_exactly_eight_fields():
    assert [f.name for f in dataclasses.fields(PinMap)] == [
        "flags",
        "direction",
        "pull_up",
        "pull_down",
        "out_default",
        "out_polarity",
        "in_polarity",
        "edge",
    ]


def test_default_map():
    d = PinMap.default()
    assert d == PinMap(
        flags=0,
        direction=0,
        pull_up=0,
        pull_down=VALID_DIO_MASK,
        out_default=0,
        out_polarity=0,
        in_polarity=0,
        edge=VALID_DIO_MASK,
    )
    d.validate()


def test_validate_accepts_documented_map_and_extremes():
    base_map().validate()
    PinMap(0, VALID_DIO_MASK, 0, 0, VALID_DIO_MASK, VALID_DIO_MASK, 0, 0).validate()
    base_map(
        direction=(1 << 22) | (1 << 26) | (1 << 27),
        pull_up=0,
        pull_down=0,
        out_default=0,
        out_polarity=0,
        in_polarity=0,
        edge=0,
    ).validate()


def test_validate_rejects_reserved_flags():
    for flags in (0x01, 0x80, 0xFF):
        rejects(base_map(flags=flags), "flags")


@pytest.mark.parametrize("bit", [23, 24, 25, 28, 31])
def test_validate_rejects_direction_outside_valid(bit):
    rejects(
        PinMap(0, 1 << bit, 0, 0, 0, 0, 0, 0),
        "direction",
    )


def test_validate_rejects_pull_up_outside_valid_or_on_output():
    rejects(base_map(pull_up=0x10000000, pull_down=0), "pull_up")
    rejects(base_map(pull_up=0x00000001, pull_down=0), "pull_up")


def test_validate_rejects_pull_down_outside_valid_or_on_output():
    rejects(base_map(pull_up=0, pull_down=0x10000000), "pull_down")
    rejects(base_map(pull_up=0, pull_down=0x00000002), "pull_down")


def test_validate_rejects_pull_up_and_pull_down_on_same_pin():
    rejects(base_map(pull_up=0x30, pull_down=0x10), "pull_up & pull_down")


def test_validate_rejects_out_default_outside_direction():
    rejects(base_map(out_default=0x10), "out_default")
    rejects(base_map(out_default=0x1F), "out_default")


def test_validate_rejects_out_polarity_outside_direction():
    rejects(base_map(out_polarity=0x10), "out_polarity")


def test_validate_rejects_in_polarity_on_outputs_or_outside_valid():
    rejects(base_map(in_polarity=0x01), "in_polarity")
    rejects(base_map(in_polarity=0x10000000), "in_polarity")


def test_validate_rejects_edge_on_outputs_or_outside_valid():
    rejects(base_map(edge=0x01), "edge")
    rejects(base_map(edge=0x10000000), "edge")


MAP_GET = (
    "v=2 flags=0x00 dir=0x0000000f pu=0x000000f0 pd=0x0c7fff00 def=0x00000005 "
    "opol=0x00000008 ipol=0x00000100 edge=0x0c7ffff0"
)


def test_to_set_args_is_map_get_payload_and_round_trips():
    pin_map = base_map()
    assert pin_map.to_set_args() == MAP_GET
    assert PinMap.parse_get(MAP_GET) == pin_map
    assert PinMap.parse_get(MAP_GET).to_set_args() == MAP_GET


def test_to_set_args_refuses_invalid_map():
    with pytest.raises(InvalidArgumentError):
        base_map(flags=1).to_set_args()


def test_parse_get_rejects_invalid_device_map_and_wrong_version():
    with pytest.raises(ParseError):
        PinMap.parse_get(MAP_GET.replace("flags=0x00", "flags=0x01"))
    with pytest.raises(ParseError):
        PinMap.parse_get(MAP_GET.replace("v=2", "v=1"))


def test_pinmap_json_matches_documented_example():
    assert dataclasses.asdict(base_map()) == {
        "flags": 0,
        "direction": 15,
        "pull_up": 240,
        "pull_down": 209714944,
        "out_default": 5,
        "out_polarity": 8,
        "in_polarity": 256,
        "edge": 209715184,
    }


# --- PatternStep ---


def test_hold_ticks_from_ns_converts_multiples_of_200():
    assert hold_ticks_from_ns(200) == 1
    assert hold_ticks_from_ns(1000) == 5
    assert hold_ticks_from_ns(200 * 0xFFFFFFFF) == 0xFFFFFFFF


@pytest.mark.parametrize("ns", [1, 199, 201, 399, 1001])
def test_hold_ticks_from_ns_never_rounds(ns):
    with pytest.raises(InvalidArgumentError):
        hold_ticks_from_ns(ns)


@pytest.mark.parametrize("ns", [0, -200, 200 * 0x100000000])
def test_hold_ticks_from_ns_rejects_zero_negative_and_overflow(ns):
    with pytest.raises(InvalidArgumentError):
        hold_ticks_from_ns(ns)


def test_pattern_step_text_and_hold_ns():
    step = PatternStep(out_bits=0x1, hold_ticks=5)
    assert step.to_text() == "0x1:5"
    assert step.hold_ns() == 1000
    assert PatternStep(0, 1).to_text() == "0x0:1"
    assert PatternStep(0x0C000000, 0xFFFFFFFF).hold_ns() == 0xFFFFFFFF * 200


def test_pattern_step_validation():
    PatternStep(0, 1).validate()
    PatternStep(VALID_DIO_MASK, 0xFFFFFFFF).validate()
    for bad in (
        PatternStep(0x00800000, 1),
        PatternStep(1 << 28, 1),
        PatternStep(0, 0),
        PatternStep(0, 0x100000000),
        PatternStep(-1, 1),
    ):
        with pytest.raises(InvalidArgumentError):
            bad.validate()
        with pytest.raises(InvalidArgumentError):
            bad.to_text()


# --- Capabilities / VersionInfo ---


def caps(features: int) -> Capabilities:
    return Capabilities(
        dio=25,
        out=12,
        in_=13,
        ts_res_ns=40,
        tick_ns=200,
        pattern_max=256,
        ring=256,
        features=features,
    )


def test_capabilities_feature_helpers():
    assert (FEAT_SYNC, FEAT_RESET) == (1, 2)
    assert caps(FEAT_SYNC).has_sync() and not caps(FEAT_SYNC).has_reset()
    assert caps(FEAT_RESET).has_reset() and not caps(FEAT_RESET).has_sync()
    assert caps(3).has_sync() and caps(3).has_reset()
    assert not caps(0).has_sync() and not caps(0).has_reset()


def test_capabilities_json_uses_plain_in_key():
    # Python field is ``in_`` (keyword); the wire/JSON key is ``in``.
    assert caps(0).to_json_dict()["in"] == 13
    assert caps(0).to_json_dict()["pattern_max"] == 256
    assert "in_" not in caps(0).to_json_dict()


def test_version_info_string():
    assert VersionInfo(0, 1, 3, 2).fw == "0.1.3"


# --- TimestampEvent ---


def test_timestamp_ns_uses_phase_only_when_sync_is_active():
    synced = TimestampEvent(inputs=1, raw_count=2, raw_phase=12, sync_active=True)
    assert synced.ns(40) == 2480
    free = TimestampEvent(inputs=1, raw_count=107, raw_phase=0, sync_active=False)
    assert free.ns(40) == 107000


def test_timestamp_ns_ignores_nonzero_phase_when_free_running():
    # Discriminates the sync gate: a stray phase must not leak into ns.
    free = TimestampEvent(inputs=1, raw_count=107, raw_phase=5, sync_active=False)
    assert free.ns(40) == 107000


def test_timestamp_ns_takes_resolution_from_caller():
    ev = TimestampEvent(inputs=0, raw_count=1, raw_phase=3, sync_active=True)
    assert ev.ns(40) == 1120
    assert ev.ns(25) == 1075


def test_timestamp_event_has_no_precomputed_ns_field():
    names = {f.name for f in dataclasses.fields(TimestampEvent)}
    assert names == {"inputs", "raw_count", "raw_phase", "sync_active"}


def test_timestamp_result_json_matches_documented_example():
    result = TimestampResult(
        events=[
            TimestampEvent(1, 2, 12, True),
            TimestampEvent(0, 107, 0, False),
        ],
        overflow=False,
    )
    assert json.loads(json.dumps(dataclasses.asdict(result))) == {
        "events": [
            {"inputs": 1, "raw_count": 2, "raw_phase": 12, "sync_active": True},
            {"inputs": 0, "raw_count": 107, "raw_phase": 0, "sync_active": False},
        ],
        "overflow": False,
    }
