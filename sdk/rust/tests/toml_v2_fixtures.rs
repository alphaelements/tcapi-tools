//! Consistency check between `docs/config-files.md`, the reference evaluator
//! below and `docs/fixtures/*.toml` (the TOML v2 canonical fixtures shared with
//! the other repos via `scripts/sync-protocol-golden.sh`).
//!
//! Three-way lock:
//! * the evaluator result must equal each fixture's `# expected*` comments;
//! * every error message template documented in section 4 of the document must
//!   be produced by at least one fixture, and every fixture error must match a
//!   documented template;
//! * `VALID_DIO_MASK` in the document must equal the constant used here.
//!
//! The evaluator is NOT the SDK parser; the SDK/CLI/GUI parsers must reproduce
//! the same results (message and line) from the same files.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use toml::{Table, Value};

const VALID_DIO_MASK: u32 = 0x0c7f_ffff;
const TICK_NS: i64 = 200;

fn docs_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs")
}

fn fixtures_dir() -> PathBuf {
    docs_dir().join("fixtures")
}

// ------------------------------------------------------------------ errors

/// Where an error is reported (spec R-TOML1: line-numbered errors).
#[derive(Clone, Copy)]
enum Loc<'a> {
    /// Whole-file error (missing `version`, no steps): line 1.
    File,
    /// A top-level key or a pin key (also matches `[key]` / `[pins.key]` headers).
    Key(&'a str),
    /// The header line of step `n` (1-based).
    Step(usize),
    /// Key `name` inside step `n`; the step header if the key is absent.
    StepKey(usize, &'a str),
}

#[derive(Debug, PartialEq)]
struct Fail {
    msg: String,
    line: usize,
}

struct Src<'a> {
    lines: Vec<&'a str>,
}

impl<'a> Src<'a> {
    fn new(src: &'a str) -> Self {
        Src {
            lines: src.lines().collect(),
        }
    }

    fn is_code(l: &str) -> bool {
        let t = l.trim_start();
        !t.is_empty() && !t.starts_with('#')
    }

    fn key_line(&self, name: &str) -> Option<usize> {
        let tables = [format!("[{name}]"), format!("[pins.{name}]")];
        self.lines.iter().position(|l| {
            if !Self::is_code(l) {
                return false;
            }
            let t = l.trim();
            if tables.iter().any(|h| h == t) {
                return true;
            }
            let t = t.trim_start_matches('"');
            t.strip_prefix(name).is_some_and(|rest| {
                let rest = rest.trim_start_matches('"');
                rest.starts_with([' ', '\t', '=', '.'])
            })
        })
    }

    fn step_header(&self, n: usize) -> Option<usize> {
        self.lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.trim() == "[[step]]")
            .nth(n - 1)
            .map(|(i, _)| i)
    }

    fn line(&self, loc: Loc) -> usize {
        let idx = match loc {
            Loc::File => None,
            Loc::Key(k) => self.key_line(k),
            Loc::Step(n) => self.step_header(n),
            Loc::StepKey(n, k) => self.step_header(n).map(|h| {
                self.lines[h + 1..]
                    .iter()
                    .take_while(|l| !l.trim_start().starts_with('['))
                    .position(|l| {
                        Self::is_code(l)
                            && l.trim_start()
                                .strip_prefix(k)
                                .is_some_and(|r| r.starts_with([' ', '\t', '=']))
                    })
                    .map_or(h, |p| h + 1 + p)
            }),
        };
        idx.map_or(1, |i| i + 1)
    }

    fn fail<T>(&self, loc: Loc, msg: impl Into<String>) -> Result<T, Fail> {
        Err(Fail {
            msg: msg.into(),
            line: self.line(loc),
        })
    }

    fn parse(&self, src: &str) -> Result<Table, Fail> {
        src.parse::<Table>().map_err(|e| Fail {
            msg: format!("toml syntax: {}", e.message()),
            line: e.span().map_or(1, |sp| {
                src[..sp.start].bytes().filter(|&b| b == b'\n').count() + 1
            }),
        })
    }
}

// ----------------------------------------------------------------- helpers

/// Canonical pin name grammar: `GP(0|[1-9][0-9]*)` whose number is in `VALID_DIO_MASK`.
fn pin_number(name: &str) -> Option<u32> {
    let digits = name.strip_prefix("GP")?;
    let canonical = digits == "0"
        || (digits.starts_with(|c: char| ('1'..='9').contains(&c))
            && digits.bytes().all(|b| b.is_ascii_digit()));
    if !canonical {
        return None;
    }
    let n: u32 = digits.parse().ok()?;
    (n < 32 && VALID_DIO_MASK & (1 << n) != 0).then_some(n)
}

fn check_keys(
    s: &Src,
    t: &Table,
    allowed: &[&str],
    step: Option<usize>,
    ctx: &str,
) -> Result<(), Fail> {
    for k in t.keys() {
        if !allowed.contains(&k.as_str()) {
            let loc = match step {
                Some(n) => Loc::StepKey(n, k),
                None => Loc::Key(k),
            };
            return s.fail(loc, format!("unknown key \"{k}\"{ctx}"));
        }
    }
    Ok(())
}

fn check_version(s: &Src, t: &Table) -> Result<(), Fail> {
    match t.get("version") {
        None => s.fail(Loc::File, "missing key \"version\""),
        Some(Value::Integer(2)) => Ok(()),
        Some(Value::Integer(v)) => s.fail(
            Loc::Key("version"),
            format!("unsupported version: expected 2, got {v}"),
        ),
        Some(_) => s.fail(Loc::Key("version"), "version must be an integer"),
    }
}

// --------------------------------------------------------------------- map

/// Returns the `# expected:` style summary of a map file.
fn eval_map(src: &str) -> Result<String, Fail> {
    let s = Src::new(src);
    let t = s.parse(src)?;
    check_version(&s, &t)?;
    check_keys(&s, &t, &["version", "pins"], None, "")?;
    let empty = Table::new();
    let pins = match t.get("pins") {
        None => &empty,
        Some(Value::Table(p)) => p,
        Some(_) => return s.fail(Loc::Key("pins"), "pins must be a table"),
    };
    let (mut dir, mut up, mut down, mut def, mut opol, mut ipol, mut edge) =
        (0u32, 0u32, 0u32, 0u32, 0u32, 0u32, 0u32);
    let mut listed = BTreeSet::new();
    for (name, v) in pins {
        let loc = Loc::Key(name);
        let Some(n) = pin_number(name) else {
            return s.fail(
                loc,
                format!("invalid pin {name}: valid pins are GP0-GP22, GP26, GP27"),
            );
        };
        let Some(cfg) = v.as_table() else {
            return s.fail(loc, format!("{name}: pin must be a table"));
        };
        check_keys(
            &s,
            cfg,
            &["dir", "default", "invert", "pull", "edge"],
            None,
            &format!(" in {name}"),
        )
        .map_err(|f| Fail {
            line: s.line(loc),
            ..f
        })?;
        listed.insert(n);
        let bit = 1u32 << n;
        let is_out = match cfg.get("dir") {
            None => false,
            Some(Value::String(d)) if d == "in" => false,
            Some(Value::String(d)) if d == "out" => true,
            Some(_) => return s.fail(loc, format!("{name}: dir must be \"in\" or \"out\"")),
        };
        let invert = match cfg.get("invert") {
            None => false,
            Some(Value::Boolean(b)) => *b,
            Some(_) => return s.fail(loc, format!("{name}: invert must be a boolean")),
        };
        if is_out {
            if cfg.contains_key("pull") {
                return s.fail(loc, format!("{name}: pull is not allowed on an output pin"));
            }
            if cfg.contains_key("edge") {
                return s.fail(loc, format!("{name}: edge is not allowed on an output pin"));
            }
            dir |= bit;
            match cfg.get("default") {
                None | Some(Value::Integer(0)) => {}
                Some(Value::Integer(1)) => def |= bit,
                Some(_) => return s.fail(loc, format!("{name}: default must be 0 or 1")),
            }
            if invert {
                opol |= bit;
            }
        } else {
            if cfg.contains_key("default") {
                return s.fail(
                    loc,
                    format!("{name}: default is only allowed on an output pin"),
                );
            }
            match cfg.get("pull") {
                None => down |= bit,
                Some(Value::String(p)) if p == "down" => down |= bit,
                Some(Value::String(p)) if p == "up" => up |= bit,
                Some(Value::String(p)) if p == "none" => {}
                Some(_) => {
                    return s.fail(
                        loc,
                        format!("{name}: pull must be \"up\", \"down\" or \"none\""),
                    )
                }
            }
            match cfg.get("edge") {
                None | Some(Value::Boolean(true)) => edge |= bit,
                Some(Value::Boolean(false)) => {}
                Some(_) => return s.fail(loc, format!("{name}: edge must be a boolean")),
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

// ----------------------------------------------------------------- pattern

fn ticks(s: &Src, step: usize, unit: &str, hold: &Value) -> Result<u32, Fail> {
    let loc = Loc::StepKey(step, "hold");
    let Some(h) = hold.as_integer() else {
        return s.fail(loc, format!("step {step}: hold must be an integer"));
    };
    let t = match unit {
        "tick" => h,
        "ns" => {
            if h % TICK_NS != 0 {
                return s.fail(
                    loc,
                    format!("step {step}: hold {h} ns is not a multiple of {TICK_NS} ns"),
                );
            }
            h / TICK_NS
        }
        _ => h.saturating_mul(1000 / TICK_NS),
    };
    if t < 1 {
        return s.fail(loc, format!("step {step}: hold must be at least 1 tick"));
    }
    u32::try_from(t).or_else(|_| {
        s.fail(
            loc,
            format!("step {step}: hold {h} {unit} exceeds the u32 tick range"),
        )
    })
}

/// Returns the list of `# expected_step:` lines of a pattern file.
fn eval_pattern(src: &str) -> Result<Vec<String>, Fail> {
    let s = Src::new(src);
    let t = s.parse(src)?;
    check_version(&s, &t)?;
    check_keys(&s, &t, &["version", "unit", "step"], None, "")?;
    let unit = match t.get("unit") {
        None => "tick",
        Some(Value::String(u)) if ["tick", "ns", "us"].contains(&u.as_str()) => u.as_str(),
        Some(Value::String(u)) => {
            return s.fail(
                Loc::Key("unit"),
                format!("invalid unit \"{u}\": expected \"tick\", \"ns\" or \"us\""),
            )
        }
        Some(_) => return s.fail(Loc::Key("unit"), "unit must be a string"),
    };
    let steps = match t.get("step") {
        Some(Value::Array(a)) if !a.is_empty() => a,
        Some(Value::Array(_)) | None => return s.fail(Loc::File, "pattern has no steps"),
        Some(_) => return s.fail(Loc::Key("step"), "step must be an array of tables"),
    };
    let mut out = Vec::new();
    for (i, st) in steps.iter().enumerate() {
        let n = i + 1;
        let Some(st) = st.as_table() else {
            return s.fail(Loc::Key("step"), format!("step {n}: step must be a table"));
        };
        check_keys(
            &s,
            st,
            &["out", "out_bits", "hold"],
            Some(n),
            &format!(" in step {n}"),
        )?;
        let bits = match (st.get("out"), st.get("out_bits")) {
            (Some(_), Some(_)) => {
                return s.fail(
                    Loc::Step(n),
                    format!("step {n}: out and out_bits are mutually exclusive"),
                )
            }
            (None, None) => {
                return s.fail(
                    Loc::Step(n),
                    format!("step {n}: one of out or out_bits is required"),
                )
            }
            (Some(Value::Array(pins)), None) => {
                let loc = Loc::StepKey(n, "out");
                let mut b = 0u32;
                for p in pins {
                    let Some(name) = p.as_str() else {
                        return s.fail(loc, format!("step {n}: out must be an array of pin names"));
                    };
                    let Some(bit) = pin_number(name) else {
                        return s.fail(loc, format!("step {n}: invalid pin \"{name}\" in out"));
                    };
                    b |= 1 << bit;
                }
                b
            }
            (Some(_), None) => {
                return s.fail(
                    Loc::StepKey(n, "out"),
                    format!("step {n}: out must be an array of pin names"),
                )
            }
            (None, Some(Value::Integer(v))) => {
                let loc = Loc::StepKey(n, "out_bits");
                let Ok(b) = u32::try_from(*v) else {
                    return s.fail(
                        loc,
                        format!("step {n}: out_bits must be between 0 and 0xffffffff"),
                    );
                };
                if b & !VALID_DIO_MASK != 0 {
                    return s.fail(
                        loc,
                        format!("step {n}: out_bits 0x{b:08x} has bits outside VALID_DIO_MASK"),
                    );
                }
                b
            }
            (None, Some(_)) => {
                return s.fail(
                    Loc::StepKey(n, "out_bits"),
                    format!("step {n}: out_bits must be an integer"),
                )
            }
        };
        let Some(hold) = st.get("hold") else {
            return s.fail(Loc::Step(n), format!("step {n}: hold is required"));
        };
        let hold_ticks = ticks(&s, n, unit, hold)?;
        out.push(format!("out_bits=0x{bits:08x} hold_ticks={hold_ticks}"));
    }
    Ok(out)
}

// ----------------------------------------------------------------- fixtures

fn annotations(src: &str, key: &str) -> Vec<String> {
    let prefix = format!("# {key}:");
    src.lines()
        .filter_map(|l| l.strip_prefix(&prefix))
        .map(|v| v.trim().to_string())
        .collect()
}

fn fixture_names() -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(fixtures_dir())
        .expect("docs/fixtures must exist")
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".toml"))
        .collect();
    names.sort();
    assert!(!names.is_empty());
    names
}

fn read_fixture(name: &str) -> String {
    fs::read_to_string(fixtures_dir().join(name)).unwrap()
}

/// Error of an invalid fixture, evaluated with the file kind implied by its name.
fn fixture_error(name: &str, src: &str) -> Option<Fail> {
    if name.starts_with("map-") {
        eval_map(src).err()
    } else {
        eval_pattern(src).err()
    }
}

#[test]
fn every_fixture_matches_its_expectation() {
    for name in &fixture_names() {
        let src = read_fixture(name);
        let is_map = name.starts_with("map-");
        assert!(
            is_map || name.starts_with("pattern-"),
            "{name}: unexpected fixture name"
        );
        let exact = annotations(&src, "expected_error");
        let prefix = annotations(&src, "expected_error_prefix");

        if exact.len() + prefix.len() > 0 {
            assert_eq!(
                exact.len() + prefix.len(),
                1,
                "{name}: one error annotation only"
            );
            let lines = annotations(&src, "expected_line");
            assert_eq!(
                lines.len(),
                1,
                "{name}: invalid fixtures need `# expected_line:`"
            );
            let want_line: usize = lines[0].parse().expect("expected_line is a number");
            let got = fixture_error(name, &src)
                .unwrap_or_else(|| panic!("{name}: expected an error, evaluation succeeded"));
            match (exact.first(), prefix.first()) {
                (Some(e), _) => assert_eq!(&got.msg, e, "{name}"),
                (_, Some(p)) => assert!(got.msg.starts_with(p.as_str()), "{name}: {}", got.msg),
                _ => unreachable!(),
            }
            assert_eq!(got.line, want_line, "{name}: line");
        } else if is_map {
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

#[test]
fn fixture_set_covers_required_cases() {
    let names = fixture_names();
    for required in [
        "map-default.toml",
        "map-mixed-io.toml",
        "map-all-output.toml",
        "pattern-basic.toml",
        "pattern-ns.toml",
        "pattern-us-max.toml",
        "map-invalid-version.toml",
        "map-pull-conflict.toml",
        "map-out-with-pull.toml",
        "pattern-bad-unit.toml",
        "pattern-ns-not-multiple.toml",
    ] {
        assert!(
            names.iter().any(|n| n == required),
            "missing fixture {required}"
        );
    }
}

// ------------------------------------------------------- document <-> fixtures

/// Message templates of section 4 of `docs/config-files.md`: the backticked
/// text in the last column of every table row between `## 4.` and `## 5.`.
fn documented_messages(doc: &str) -> Vec<String> {
    let mut in_errors = false;
    let mut msgs = Vec::new();
    for line in doc.lines() {
        if line.starts_with("## ") {
            in_errors = line.starts_with("## 4.");
            continue;
        }
        if !in_errors || !line.starts_with('|') {
            continue;
        }
        let last = line
            .trim_end()
            .trim_end_matches('|')
            .rsplit('|')
            .next()
            .unwrap()
            .trim();
        if let Some(m) = last.strip_prefix('`').and_then(|r| r.strip_suffix('`')) {
            msgs.push(m.to_string());
        }
    }
    msgs
}

/// Splits a template into literal pieces; `<...>` and the `N` of `step N` are wildcards.
fn template_pieces(t: &str) -> Vec<String> {
    let mut pieces = vec![String::new()];
    let mut rest = t;
    while !rest.is_empty() {
        if rest.starts_with('<') {
            let end = rest.find('>').expect("unterminated <placeholder>");
            rest = &rest[end + 1..];
            pieces.push(String::new());
        } else if rest.starts_with("step N") {
            pieces.last_mut().unwrap().push_str("step ");
            rest = &rest[6..];
            pieces.push(String::new());
        } else {
            let c = rest.chars().next().unwrap();
            pieces.last_mut().unwrap().push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    pieces
}

/// Anchored match; every wildcard must capture at least one character.
fn template_matches(template: &str, msg: &str) -> bool {
    let pieces = template_pieces(template);
    let (first, rest) = pieces.split_first().unwrap();
    let Some(mut cursor) = msg
        .strip_prefix(first.as_str())
        .map(|r| msg.len() - r.len())
    else {
        return false;
    };
    let Some((last, middle)) = rest.split_last() else {
        return msg == first;
    };
    for p in middle {
        let from = cursor + 1;
        match msg.get(from..).and_then(|t| t.find(p.as_str())) {
            Some(i) => cursor = from + i + p.len(),
            None => return false,
        }
    }
    msg.len() > cursor && msg.ends_with(last.as_str()) && msg.len() - last.len() > cursor
}

#[test]
fn template_matcher_semantics() {
    assert!(template_matches(
        "unknown key \"<key>\" in step N",
        "unknown key \"x\" in step 3"
    ));
    assert!(template_matches(
        "pins must be a table",
        "pins must be a table"
    ));
    assert!(!template_matches(
        "pins must be a table",
        "pins must be a tablex"
    ));
    assert!(template_matches(
        "toml syntax: <parser message>",
        "toml syntax: boom"
    ));
    assert!(!template_matches(
        "step N: hold is required",
        "step : hold is required"
    ));
    assert!(template_matches(
        "step N: hold is required",
        "step 12: hold is required"
    ));
    assert!(!template_matches(
        "invalid pin <name>: x",
        "invalid pin : x"
    ));
}

#[test]
fn documented_messages_and_fixtures_agree() {
    let doc = fs::read_to_string(docs_dir().join("config-files.md")).unwrap();
    let templates = documented_messages(&doc);
    assert!(
        templates.len() >= 30,
        "section 4 of config-files.md should list every message, found {}",
        templates.len()
    );

    let mut covered = vec![false; templates.len()];
    for name in &fixture_names() {
        let src = read_fixture(name);
        let Some(fail) = fixture_error(name, &src) else {
            continue;
        };
        let hits: Vec<usize> = (0..templates.len())
            .filter(|&i| template_matches(&templates[i], &fail.msg))
            .collect();
        assert!(
            !hits.is_empty(),
            "{name}: message {:?} is not documented in config-files.md section 4",
            fail.msg
        );
        for i in hits {
            covered[i] = true;
        }
    }
    let uncovered: Vec<_> = templates
        .iter()
        .zip(&covered)
        .filter(|(_, c)| !**c)
        .map(|(t, _)| t.as_str())
        .collect();
    assert!(
        uncovered.is_empty(),
        "documented messages without a fixture: {uncovered:#?}"
    );
}

#[test]
fn documented_fixture_table_lists_every_fixture() {
    let doc = fs::read_to_string(docs_dir().join("config-files.md")).unwrap();
    for name in &fixture_names() {
        assert!(
            doc.contains(&format!("`{name}`")),
            "{name} is missing from the fixture table in config-files.md"
        );
    }
}

#[test]
fn valid_dio_mask_matches_document_and_pin_list() {
    let doc = fs::read_to_string(docs_dir().join("config-files.md")).unwrap();
    let documented = doc
        .lines()
        .find_map(|l| l.strip_prefix("### `VALID_DIO_MASK = 0x"))
        .and_then(|r| r.strip_suffix('`'))
        .expect("document defines VALID_DIO_MASK in a `### ` heading");
    assert_eq!(u32::from_str_radix(documented, 16).unwrap(), VALID_DIO_MASK);
    let from_pins = (0..23).chain([26, 27]).fold(0u32, |m, n| m | (1 << n));
    assert_eq!(VALID_DIO_MASK, from_pins);
    for n in 0..32 {
        assert_eq!(
            pin_number(&format!("GP{n}")).is_some(),
            from_pins & (1 << n) != 0,
            "GP{n}"
        );
    }
}

#[test]
fn pin_name_grammar_is_canonical() {
    for ok in ["GP0", "GP1", "GP22", "GP26", "GP27"] {
        assert!(pin_number(ok).is_some(), "{ok}");
    }
    for bad in [
        "GP00",
        "GP05",
        "GP+5",
        "GP-1",
        "GP 5",
        "gp1",
        "Gp1",
        "GP",
        "GP23",
        "GP24",
        "GP25",
        "GP28",
        "GP32",
        "GP99999999999",
        " GP1",
        "GP1 ",
        "GP１",
    ] {
        assert!(pin_number(bad).is_none(), "{bad}");
    }
}

/// The pin-name grammar is written down twice in `config-files.md` (section 1
/// and the section 6 list of implementer choices). Both must carry the exact
/// canonical expression that `pin_number` implements.
#[test]
fn documented_pin_grammar_is_canonical() {
    const GRAMMAR: &str = "`GP(0|[1-9][0-9]*)`";
    let doc = fs::read_to_string(docs_dir().join("config-files.md")).expect("read config-files.md");
    let occurrences = doc.matches(GRAMMAR).count();
    assert!(
        occurrences >= 2,
        "config-files.md must state the grammar {GRAMMAR} in sections 1 and 6, found {occurrences}"
    );
    assert!(
        !doc.contains("`GP[0-9]+`"),
        "config-files.md states a non-canonical pin grammar"
    );
}
