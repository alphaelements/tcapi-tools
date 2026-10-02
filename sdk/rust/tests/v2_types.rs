//! Public-API tests for the v2 pin convention helpers and data types
//! (REF-V2 sections 2 and 4.2).

use assert_matches::assert_matches;
use pochi_sdk::{
    ch_to_gp, gp_to_ch, hold_ticks_from_ns, pin_label, PatternStep, PinMap, SdkError,
    TimestampEvent, DIO_CHANNELS, PATTERN_TICK_NS, VALID_DIO_MASK,
};

// --- pin convention (R-PIN1 / R-PIN2) ---

#[test]
fn valid_dio_mask_is_gp0_22_26_27() {
    assert_eq!(VALID_DIO_MASK, 0x0c7f_ffff);
    assert_eq!(VALID_DIO_MASK.count_ones(), 25);
    assert_eq!(DIO_CHANNELS, 25);
    for gp in [23u32, 24, 25, 28, 29, 30, 31] {
        assert_eq!(VALID_DIO_MASK & (1 << gp), 0, "GP{gp} must be outside DIO");
    }
}

#[test]
fn ch_to_gp_is_identity_for_ch0_to_ch22() {
    for ch in 0..=22u8 {
        assert_eq!(ch_to_gp(ch).unwrap(), ch);
    }
}

#[test]
fn ch23_and_ch24_map_to_gp26_and_gp27() {
    assert_eq!(ch_to_gp(23).unwrap(), 26);
    assert_eq!(ch_to_gp(24).unwrap(), 27);
}

#[test]
fn ch_to_gp_rejects_out_of_range_channel() {
    assert_matches!(ch_to_gp(25), Err(SdkError::InvalidArgument(_)));
    assert_matches!(ch_to_gp(255), Err(SdkError::InvalidArgument(_)));
}

#[test]
fn gp_to_ch_inverts_ch_to_gp() {
    for ch in 0..DIO_CHANNELS {
        let gp = ch_to_gp(ch).unwrap();
        assert_eq!(gp_to_ch(gp).unwrap(), ch);
        assert_ne!(VALID_DIO_MASK & (1 << gp), 0);
    }
}

#[test]
fn gp_to_ch_rejects_non_dio_pins() {
    for gp in [23u8, 24, 25, 28, 29, 31, 32, 255] {
        assert_matches!(gp_to_ch(gp), Err(SdkError::InvalidArgument(_)), "GP{gp}");
    }
}

#[test]
fn pin_label_shows_gp_and_channel() {
    assert_eq!(pin_label(0).unwrap(), "GP0 (ch0)");
    assert_eq!(pin_label(22).unwrap(), "GP22 (ch22)");
    assert_eq!(pin_label(26).unwrap(), "GP26 (ch23)");
    assert_eq!(pin_label(27).unwrap(), "GP27 (ch24)");
    assert_matches!(pin_label(23), Err(SdkError::InvalidArgument(_)));
}

// --- PinMap::validate (R-M1) ---

fn base_map() -> PinMap {
    PinMap::default()
}

fn rejects(map: PinMap, field: &str) {
    match map.validate() {
        Err(SdkError::InvalidArgument(msg)) => {
            assert!(msg.contains(field), "message {msg:?} should name {field}")
        }
        other => panic!("expected InvalidArgument naming {field}, got {other:?}"),
    }
}

#[test]
fn default_map_is_the_documented_default() {
    let m = PinMap::default();
    assert_eq!(m.flags, 0);
    assert_eq!(m.direction, 0);
    assert_eq!(m.pull_up, 0);
    assert_eq!(m.pull_down, VALID_DIO_MASK);
    assert_eq!(m.out_default, 0);
    assert_eq!(m.out_polarity, 0);
    assert_eq!(m.in_polarity, 0);
    assert_eq!(m.edge, VALID_DIO_MASK);
    m.validate().unwrap();
}

#[test]
fn validate_accepts_all_outputs_and_highest_pins() {
    let m = PinMap {
        direction: VALID_DIO_MASK,
        pull_down: 0,
        edge: 0,
        out_default: 0x0400_0000,
        out_polarity: 0x0800_0000,
        ..base_map()
    };
    m.validate().unwrap();
}

#[test]
fn validate_rejects_reserved_flags() {
    for flags in [0x01u8, 0x80, 0xff] {
        rejects(
            PinMap {
                flags,
                ..base_map()
            },
            "flags",
        );
    }
}

#[test]
fn validate_rejects_direction_outside_valid_mask() {
    for bit in [23u32, 24, 25, 28, 31] {
        rejects(
            PinMap {
                direction: 1 << bit,
                pull_down: 0,
                edge: 0,
                ..base_map()
            },
            "direction",
        );
    }
}

#[test]
fn validate_rejects_pull_up_outside_valid_or_on_output() {
    rejects(
        PinMap {
            pull_up: 1 << 23,
            pull_down: 0,
            ..base_map()
        },
        "pull_up",
    );
    rejects(
        PinMap {
            direction: 1,
            pull_up: 1,
            pull_down: 0,
            edge: 0,
            ..base_map()
        },
        "pull_up",
    );
}

#[test]
fn validate_rejects_pull_down_outside_valid_or_on_output() {
    rejects(
        PinMap {
            pull_down: 1 << 24,
            ..base_map()
        },
        "pull_down",
    );
    rejects(
        PinMap {
            direction: 1,
            pull_down: 1,
            edge: 0,
            ..base_map()
        },
        "pull_down",
    );
}

#[test]
fn validate_rejects_pull_up_and_pull_down_on_the_same_pin() {
    rejects(
        PinMap {
            pull_up: 0b100,
            pull_down: VALID_DIO_MASK,
            ..base_map()
        },
        "pull_up & pull_down",
    );
}

#[test]
fn validate_rejects_out_default_outside_direction() {
    rejects(
        PinMap {
            direction: 0b01,
            pull_down: VALID_DIO_MASK & !0b01,
            edge: 0,
            out_default: 0b10,
            ..base_map()
        },
        "out_default",
    );
}

#[test]
fn validate_rejects_out_polarity_outside_direction() {
    rejects(
        PinMap {
            out_polarity: 0b1,
            ..base_map()
        },
        "out_polarity",
    );
}

#[test]
fn validate_rejects_in_polarity_outside_input_pins() {
    rejects(
        PinMap {
            in_polarity: 1 << 25,
            ..base_map()
        },
        "in_polarity",
    );
    rejects(
        PinMap {
            direction: 1,
            pull_down: VALID_DIO_MASK & !1,
            edge: 0,
            in_polarity: 1,
            ..base_map()
        },
        "in_polarity",
    );
}

#[test]
fn validate_rejects_edge_outside_input_pins() {
    rejects(
        PinMap {
            edge: 1 << 28,
            ..base_map()
        },
        "edge",
    );
    rejects(
        PinMap {
            direction: 1,
            pull_down: VALID_DIO_MASK & !1,
            ..base_map()
        },
        "edge",
    );
}

// --- map text round trip (R-M3) ---

#[test]
fn to_set_args_is_the_map_get_payload_and_round_trips() {
    let line = "v=2 flags=0x00 dir=0x0000000f pu=0x000000f0 pd=0x0c7fff00 \
                def=0x00000005 opol=0x00000008 ipol=0x00000100 edge=0x0c7ffff0";
    let map = PinMap::parse_get(line).unwrap();
    assert_eq!(map.direction, 0x0f);
    assert_eq!(map.pull_up, 0xf0);
    assert_eq!(map.pull_down, 0x0c7f_ff00);
    assert_eq!(map.out_default, 5);
    assert_eq!(map.out_polarity, 8);
    assert_eq!(map.in_polarity, 0x100);
    assert_eq!(map.edge, 0x0c7f_fff0);
    assert_eq!(map.to_set_args().unwrap(), line);
}

#[test]
fn to_set_args_refuses_an_invalid_map() {
    let bad = PinMap {
        flags: 1,
        ..base_map()
    };
    assert_matches!(bad.to_set_args(), Err(SdkError::InvalidArgument(_)));
}

// --- pattern step / ticks (R-PT5) ---

#[test]
fn hold_ticks_from_ns_converts_multiples_of_200() {
    assert_eq!(PATTERN_TICK_NS, 200);
    assert_eq!(hold_ticks_from_ns(200).unwrap(), 1);
    assert_eq!(hold_ticks_from_ns(1_000).unwrap(), 5);
    assert_eq!(
        hold_ticks_from_ns(200 * u64::from(u32::MAX)).unwrap(),
        u32::MAX
    );
}

#[test]
fn hold_ticks_from_ns_never_rounds() {
    for ns in [1u64, 100, 199, 201, 399, 1_001] {
        assert_matches!(
            hold_ticks_from_ns(ns),
            Err(SdkError::InvalidArgument(_)),
            "{ns}"
        );
    }
}

#[test]
fn hold_ticks_from_ns_rejects_zero_and_u32_overflow() {
    assert_matches!(hold_ticks_from_ns(0), Err(SdkError::InvalidArgument(_)));
    assert_matches!(
        hold_ticks_from_ns(200 * (u64::from(u32::MAX) + 1)),
        Err(SdkError::InvalidArgument(_))
    );
}

#[test]
fn pattern_step_text_and_hold_ns() {
    let step = PatternStep {
        out_bits: 0x1,
        hold_ticks: 5,
    };
    assert_eq!(step.to_text().unwrap(), "0x1:5");
    assert_eq!(step.hold_ns(), 1_000);
    let zero = PatternStep {
        out_bits: 0,
        hold_ticks: 10,
    };
    assert_eq!(zero.to_text().unwrap(), "0x0:10");
}

#[test]
fn pattern_step_validation() {
    let ok = PatternStep {
        out_bits: 0x0c40_0001,
        hold_ticks: u32::MAX,
    };
    ok.validate().unwrap();
    assert_eq!(ok.hold_ns(), 200 * u64::from(u32::MAX));
    assert_matches!(
        PatternStep {
            out_bits: 1,
            hold_ticks: 0
        }
        .validate(),
        Err(SdkError::InvalidArgument(_))
    );
    assert_matches!(
        PatternStep {
            out_bits: 1 << 23,
            hold_ticks: 1
        }
        .to_text(),
        Err(SdkError::InvalidArgument(_))
    );
}

// --- timestamp ns (R-TS1) ---

#[test]
fn timestamp_ns_uses_phase_only_when_sync_is_active() {
    let synced = TimestampEvent {
        inputs: 1,
        raw_count: 1000,
        raw_phase: 7,
        sync_active: true,
    };
    assert_eq!(synced.ns(40), 1_000_280);
    assert_eq!(synced.ns(50), 1_000_350);

    let free_running = TimestampEvent {
        sync_active: false,
        raw_phase: 0,
        ..synced
    };
    assert_eq!(free_running.ns(40), 1_000_000);
}
