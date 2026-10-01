//! Consistency check for `docs/fixtures/*.toml` (the TOML v2 canonical
//! fixtures shared with the other repos via `scripts/sync-protocol-golden.sh`).
//!
//! A small reference evaluator implementing `docs/config-files.md` is run over
//! every fixture; its result must equal the fixture's `# expected*` comments.
//! This keeps the documented schema, the error messages and the fixtures in
//! agreement. It is NOT the SDK parser; the SDK/CLI/GUI parsers must reproduce
//! the same results from the same files.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use toml::{Table, Value};

const VALID_DIO_MASK: u32 = 0x0c7f_ffff;
const TICK_NS: i64 = 200;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/fixtures")
}

fn pin_bit(name: &str) -> Option<u32> {
    let n: u32 = name.strip_prefix("GP")?.parse().ok()?;
    (n < 32 && VALID_DIO_MASK & (1 << n) != 0).then_some(n)
}

fn check_keys(t: &Table, allowed: &[&str], ctx: &str) -> Result<(), String> {
    for k in t.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(format!("unknown key \"{k}\"{ctx}"));
        }
    }
    Ok(())
}

fn check_version(t: &Table) -> Result<(), String> {
    match t.get("version") {
        None => Err("missing key \"version\"".into()),
        Some(Value::Integer(2)) => Ok(()),
        Some(Value::Integer(v)) => Err(format!("unsupported version: expected 2, got {v}")),
        Some(_) => Err("version must be an integer".into()),
    }
}

/// Returns the `# expected:` style summary of a map file.
fn eval_map(src: &str) -> Result<String, String> {
    let t: Table = src.parse().map_err(|e| format!("toml syntax: {e}"))?;
    check_keys(&t, &["version", "pins"], "")?;
    check_version(&t)?;
    let empty = Table::new();
    let pins = match t.get("pins") {
        None => &empty,
        Some(Value::Table(p)) => p,
        Some(_) => return Err("pins must be a table".into()),
    };
    let (mut dir, mut up, mut down, mut def, mut opol, mut ipol, mut edge) =
        (0u32, 0u32, 0u32, 0u32, 0u32, 0u32, 0u32);
    let mut listed = BTreeSet::new();
    for (name, v) in pins {
        let n = pin_bit(name)
            .ok_or_else(|| format!("invalid pin {name}: valid pins are GP0-GP22, GP26, GP27"))?;
        let cfg = v
            .as_table()
            .ok_or_else(|| format!("{name}: pin must be a table"))?;
        check_keys(
            cfg,
            &["dir", "default", "invert", "pull", "edge"],
            &format!(" in {name}"),
        )?;
        listed.insert(n);
        let bit = 1u32 << n;
        let is_out = match cfg.get("dir") {
            None => false,
            Some(Value::String(s)) if s == "in" => false,
            Some(Value::String(s)) if s == "out" => true,
            Some(_) => return Err(format!("{name}: dir must be \"in\" or \"out\"")),
        };
        let invert = match cfg.get("invert") {
            None => false,
            Some(Value::Boolean(b)) => *b,
            Some(_) => return Err(format!("{name}: invert must be a boolean")),
        };
        if is_out {
            if cfg.contains_key("pull") {
                return Err(format!("{name}: pull is not allowed on an output pin"));
            }
            if cfg.contains_key("edge") {
                return Err(format!("{name}: edge is not allowed on an output pin"));
            }
            dir |= bit;
            match cfg.get("default") {
                None | Some(Value::Integer(0)) => {}
                Some(Value::Integer(1)) => def |= bit,
                Some(_) => return Err(format!("{name}: default must be 0 or 1")),
            }
            if invert {
                opol |= bit;
            }
        } else {
            if cfg.contains_key("default") {
                return Err(format!("{name}: default is only allowed on an output pin"));
            }
            match cfg.get("pull") {
                None => down |= bit,
                Some(Value::String(s)) if s == "down" => down |= bit,
                Some(Value::String(s)) if s == "up" => up |= bit,
                Some(Value::String(s)) if s == "none" => {}
                Some(_) => {
                    return Err(format!("{name}: pull must be \"up\", \"down\" or \"none\""))
                }
            }
            match cfg.get("edge") {
                None | Some(Value::Boolean(true)) => edge |= bit,
                Some(Value::Boolean(false)) => {}
                Some(_) => return Err(format!("{name}: edge must be a boolean")),
            }
            if invert {
                ipol |= bit;
            }
        }
    }
    // Unlisted pins: input, pull-down, edge enabled.
    for n in 0..32 {
        let bit = 1u32 << n;
        if VALID_DIO_MASK & bit != 0 && !listed.contains(&n) {
            down |= bit;
            edge |= bit;
        }
    }
    Ok(format!(
        "dir=0x{dir:08x} pull_up=0x{up:08x} pull_down=0x{down:08x} out_default=0x{def:08x} \
         out_polarity=0x{opol:08x} in_polarity=0x{ipol:08x} edge=0x{edge:08x}"
    ))
}

fn ticks(step: usize, unit: &str, hold: &Value) -> Result<u32, String> {
    let h = hold
        .as_integer()
        .ok_or_else(|| format!("step {step}: hold must be an integer"))?;
    let t = match unit {
        "tick" => h,
        "ns" => {
            if h % TICK_NS != 0 {
                return Err(format!(
                    "step {step}: hold {h} ns is not a multiple of {TICK_NS} ns"
                ));
            }
            h / TICK_NS
        }
        _ => h.saturating_mul(1000 / TICK_NS),
    };
    if t < 1 {
        return Err(format!("step {step}: hold must be at least 1 tick"));
    }
    u32::try_from(t).map_err(|_| format!("step {step}: hold {h} {unit} exceeds the u32 tick range"))
}

/// Returns the list of `# expected_step:` lines of a pattern file.
fn eval_pattern(src: &str) -> Result<Vec<String>, String> {
    let t: Table = src.parse().map_err(|e| format!("toml syntax: {e}"))?;
    check_keys(&t, &["version", "unit", "step"], "")?;
    check_version(&t)?;
    let unit = match t.get("unit") {
        None => "tick",
        Some(Value::String(s)) if ["tick", "ns", "us"].contains(&s.as_str()) => s.as_str(),
        Some(Value::String(s)) => {
            return Err(format!(
                "invalid unit \"{s}\": expected \"tick\", \"ns\" or \"us\""
            ))
        }
        Some(_) => return Err("unit must be a string".into()),
    };
    let steps = match t.get("step") {
        Some(Value::Array(a)) if !a.is_empty() => a,
        _ => return Err("pattern has no steps".into()),
    };
    let mut out = Vec::new();
    for (i, s) in steps.iter().enumerate() {
        let n = i + 1;
        let st = s
            .as_table()
            .ok_or_else(|| format!("step {n}: step must be a table"))?;
        check_keys(st, &["out", "out_bits", "hold"], &format!(" in step {n}"))?;
        let bits = match (st.get("out"), st.get("out_bits")) {
            (Some(_), Some(_)) => {
                return Err(format!("step {n}: out and out_bits are mutually exclusive"))
            }
            (None, None) => return Err(format!("step {n}: one of out or out_bits is required")),
            (Some(Value::Array(pins)), None) => {
                let mut b = 0u32;
                for p in pins {
                    let name = p.as_str().unwrap_or("");
                    let bit = pin_bit(name)
                        .ok_or_else(|| format!("step {n}: invalid pin \"{name}\" in out"))?;
                    b |= 1 << bit;
                }
                b
            }
            (Some(_), None) => return Err(format!("step {n}: out must be an array of pin names")),
            (None, Some(Value::Integer(v))) => {
                let b = u32::try_from(*v).unwrap_or(u32::MAX);
                if b & !VALID_DIO_MASK != 0 {
                    return Err(format!(
                        "step {n}: out_bits 0x{v:08x} has bits outside VALID_DIO_MASK"
                    ));
                }
                b
            }
            (None, Some(_)) => return Err(format!("step {n}: out_bits must be an integer")),
        };
        let hold = st
            .get("hold")
            .ok_or_else(|| format!("step {n}: hold is required"))?;
        let hold_ticks = ticks(n, unit, hold)?;
        out.push(format!("out_bits=0x{bits:08x} hold_ticks={hold_ticks}"));
    }
    Ok(out)
}

fn annotations(src: &str, key: &str) -> Vec<String> {
    let prefix = format!("# {key}:");
    src.lines()
        .filter_map(|l| l.strip_prefix(&prefix))
        .map(|v| v.trim().to_string())
        .collect()
}

#[test]
fn every_fixture_matches_its_expectation() {
    let mut names: Vec<_> = fs::read_dir(fixtures_dir())
        .expect("docs/fixtures must exist")
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".toml"))
        .collect();
    names.sort();
    assert!(!names.is_empty());

    for name in &names {
        let src = fs::read_to_string(fixtures_dir().join(name)).unwrap();
        let errors = annotations(&src, "expected_error");
        let is_map = name.starts_with("map-");
        assert!(
            is_map || name.starts_with("pattern-"),
            "{name}: unexpected fixture name"
        );

        if let [expected_err] = errors.as_slice() {
            let got = if is_map {
                eval_map(&src).map(|_| ())
            } else {
                eval_pattern(&src).map(|_| ())
            };
            assert_eq!(got.as_ref().err(), Some(expected_err), "{name}");
        } else {
            assert!(errors.is_empty(), "{name}: more than one expected_error");
            if is_map {
                let expected = annotations(&src, "expected");
                assert_eq!(expected.len(), 1, "{name}: needs exactly one `# expected:`");
                assert_eq!(eval_map(&src).as_ref(), Ok(&expected[0]), "{name}");
            } else {
                let expected = annotations(&src, "expected_step");
                assert!(
                    !expected.is_empty(),
                    "{name}: needs `# expected_step:` lines"
                );
                assert_eq!(eval_pattern(&src), Ok(expected), "{name}");
            }
        }
    }
}

#[test]
fn fixture_set_covers_required_cases() {
    for required in [
        "map-default.toml",
        "map-mixed-io.toml",
        "map-all-output.toml",
        "pattern-basic.toml",
        "pattern-ns.toml",
        "map-invalid-version.toml",
        "map-pull-conflict.toml",
        "map-out-with-pull.toml",
        "pattern-bad-unit.toml",
        "pattern-ns-not-multiple.toml",
    ] {
        assert!(
            fixtures_dir().join(required).is_file(),
            "missing fixture {required}"
        );
    }
}

#[test]
fn valid_dio_mask_is_gp0_22_gp26_gp27() {
    let expected = (0..23).chain([26, 27]).fold(0u32, |m, n| m | (1 << n));
    assert_eq!(VALID_DIO_MASK, expected);
}
