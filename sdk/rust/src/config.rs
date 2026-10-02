//! Parsers for the host-side TOML files `map.toml` and `pattern.toml`
//! (schema v2, `docs/config-files.md`, R-TOML1/R-TOML2).
//!
//! There is no lenient mode: a `version` other than 2, an unknown key or a
//! contradictory setting is an error, and every error names the file and the
//! 1-based line of the offending element (`<file>:<line>: <message>`). The
//! message texts are the ones of section 4 of the document; the shared
//! fixtures in `docs/fixtures/` pin them down for every implementation.
//!
//! Exactly one error is reported: the first failing check, in the order the
//! document defines (syntax, `version`, unknown top-level keys, then the
//! remaining keys). For a map with several faulty pins, which pin is reported
//! first is not defined.

use std::fmt;
use std::path::Path;

use toml::{Table, Value};

use crate::error::SdkError;
use crate::types::{PatternStep, PinMap, PATTERN_TICK_NS, PROTO_VERSION, VALID_DIO_MASK};

/// Nanoseconds in a microsecond (`unit = "us"`).
const NS_PER_US: i64 = 1000;

/// A rejected configuration file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    /// Name of the file as given to the parser (used in the message only).
    pub file: String,
    /// 1-based line of the offending element.
    pub line: usize,
    /// The message of `docs/config-files.md` section 4, without the prefix.
    pub message: String,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {}", self.file, self.line, self.message)
    }
}

impl std::error::Error for ConfigError {}

impl From<ConfigError> for SdkError {
    fn from(e: ConfigError) -> Self {
        SdkError::Parse(e.to_string())
    }
}

/// Parse the text of a `map.toml` into the pin map it describes. `file` only
/// labels errors. Pins that are not listed are inputs with pull-down and edge
/// detection; `flags` is always 0.
pub fn parse_map(src: &str, file: &str) -> Result<PinMap, ConfigError> {
    eval_map(src).map_err(|f| f.in_file(file))
}

/// Parse the text of a `pattern.toml` into its steps, in file order, with
/// every hold converted to pattern ticks. `file` only labels errors.
pub fn parse_pattern(src: &str, file: &str) -> Result<Vec<PatternStep>, ConfigError> {
    eval_pattern(src).map_err(|f| f.in_file(file))
}

/// Read and parse a `map.toml`. Errors carry the path of the file.
pub fn load_map(path: &Path) -> Result<PinMap, SdkError> {
    let src = std::fs::read_to_string(path)?;
    Ok(parse_map(&src, &path.display().to_string())?)
}

/// Read and parse a `pattern.toml`. Errors carry the path of the file.
pub fn load_pattern(path: &Path) -> Result<Vec<PatternStep>, SdkError> {
    let src = std::fs::read_to_string(path)?;
    Ok(parse_pattern(&src, &path.display().to_string())?)
}

// ------------------------------------------------------------------ errors

/// Where an error is reported.
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

/// An error before the file name is attached.
struct Fail {
    message: String,
    line: usize,
}

impl Fail {
    fn in_file(self, file: &str) -> ConfigError {
        ConfigError {
            file: file.to_string(),
            line: self.line,
            message: self.message,
        }
    }
}

/// The source text, for mapping an element to its line. The `toml` value tree
/// carries no positions, so the line is found by scanning for the key.
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

    /// Line index of `name` as a key (`name = ...`, `"name" = ...`,
    /// `name.sub = ...`) or as a table header (`[name]`, `[[name]]`,
    /// `[pins.name]`).
    fn key_line(&self, name: &str) -> Option<usize> {
        let tables = [
            format!("[{name}]"),
            format!("[[{name}]]"),
            format!("[pins.{name}]"),
        ];
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

    /// Line index of the header of the `n`-th (1-based) `[[step]]`.
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
        // Whole-file errors, and elements that cannot be located, are line 1.
        idx.map_or(1, |i| i + 1)
    }

    fn fail<T>(&self, loc: Loc, message: impl Into<String>) -> Result<T, Fail> {
        Err(Fail {
            message: message.into(),
            line: self.line(loc),
        })
    }

    fn parse(&self, src: &str) -> Result<Table, Fail> {
        src.parse::<Table>().map_err(|e| Fail {
            message: format!("toml syntax: {}", e.message()),
            line: e.span().map_or(1, |sp| {
                src[..sp.start].bytes().filter(|&b| b == b'\n').count() + 1
            }),
        })
    }
}

// ----------------------------------------------------------------- helpers

/// Canonical pin name grammar: `GP(0|[1-9][0-9]*)` whose number is in
/// [`VALID_DIO_MASK`].
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
        Some(Value::Integer(v)) if *v == i64::from(PROTO_VERSION) => Ok(()),
        Some(Value::Integer(v)) => s.fail(
            Loc::Key("version"),
            format!("unsupported version: expected {PROTO_VERSION}, got {v}"),
        ),
        Some(_) => s.fail(Loc::Key("version"), "version must be an integer"),
    }
}

// --------------------------------------------------------------------- map

fn eval_map(src: &str) -> Result<PinMap, Fail> {
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

    let mut map = PinMap {
        direction: 0,
        pull_up: 0,
        pull_down: 0,
        out_default: 0,
        out_polarity: 0,
        in_polarity: 0,
        edge: 0,
        ..PinMap::default()
    };
    let mut listed = 0u32;
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
        let bit = 1u32 << n;
        listed |= bit;
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
            map.direction |= bit;
            match cfg.get("default") {
                None | Some(Value::Integer(0)) => {}
                Some(Value::Integer(1)) => map.out_default |= bit,
                Some(_) => return s.fail(loc, format!("{name}: default must be 0 or 1")),
            }
            if invert {
                map.out_polarity |= bit;
            }
        } else {
            if cfg.contains_key("default") {
                return s.fail(
                    loc,
                    format!("{name}: default is only allowed on an output pin"),
                );
            }
            match cfg.get("pull") {
                None => map.pull_down |= bit,
                Some(Value::String(p)) if p == "down" => map.pull_down |= bit,
                Some(Value::String(p)) if p == "up" => map.pull_up |= bit,
                Some(Value::String(p)) if p == "none" => {}
                Some(_) => {
                    return s.fail(
                        loc,
                        format!("{name}: pull must be \"up\", \"down\" or \"none\""),
                    )
                }
            }
            match cfg.get("edge") {
                None | Some(Value::Boolean(true)) => map.edge |= bit,
                Some(Value::Boolean(false)) => {}
                Some(_) => return s.fail(loc, format!("{name}: edge must be a boolean")),
            }
            if invert {
                map.in_polarity |= bit;
            }
        }
    }
    // Unlisted pins: input, pull-down, edge enabled.
    let unlisted = VALID_DIO_MASK & !listed;
    map.pull_down |= unlisted;
    map.edge |= unlisted;
    Ok(map)
}

// ----------------------------------------------------------------- pattern

/// Convert the `hold` of step `step` to pattern ticks (1..=u32::MAX).
fn ticks(s: &Src, step: usize, unit: &str, hold: &Value) -> Result<u32, Fail> {
    let tick_ns = i64::from(PATTERN_TICK_NS);
    let loc = Loc::StepKey(step, "hold");
    let Some(h) = hold.as_integer() else {
        return s.fail(loc, format!("step {step}: hold must be an integer"));
    };
    let t = match unit {
        "tick" => h,
        "ns" => {
            if h % tick_ns != 0 {
                return s.fail(
                    loc,
                    format!("step {step}: hold {h} ns is not a multiple of {tick_ns} ns"),
                );
            }
            h / tick_ns
        }
        _ => h.saturating_mul(NS_PER_US / tick_ns),
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

fn eval_pattern(src: &str) -> Result<Vec<PatternStep>, Fail> {
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
    let mut out = Vec::with_capacity(steps.len());
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
        let out_bits = step_out_bits(&s, n, st)?;
        let Some(hold) = st.get("hold") else {
            return s.fail(Loc::Step(n), format!("step {n}: hold is required"));
        };
        out.push(PatternStep {
            out_bits,
            hold_ticks: ticks(&s, n, unit, hold)?,
        });
    }
    Ok(out)
}

/// The output mask of step `n` from `out` (pin names) or `out_bits`.
fn step_out_bits(s: &Src, n: usize, st: &Table) -> Result<u32, Fail> {
    match (st.get("out"), st.get("out_bits")) {
        (Some(_), Some(_)) => s.fail(
            Loc::Step(n),
            format!("step {n}: out and out_bits are mutually exclusive"),
        ),
        (None, None) => s.fail(
            Loc::Step(n),
            format!("step {n}: one of out or out_bits is required"),
        ),
        (Some(Value::Array(pins)), None) => {
            let loc = Loc::StepKey(n, "out");
            let mut bits = 0u32;
            for p in pins {
                let Some(name) = p.as_str() else {
                    return s.fail(loc, format!("step {n}: out must be an array of pin names"));
                };
                let Some(bit) = pin_number(name) else {
                    return s.fail(loc, format!("step {n}: invalid pin \"{name}\" in out"));
                };
                bits |= 1 << bit;
            }
            Ok(bits)
        }
        (Some(_), None) => s.fail(
            Loc::StepKey(n, "out"),
            format!("step {n}: out must be an array of pin names"),
        ),
        (None, Some(Value::Integer(v))) => {
            let loc = Loc::StepKey(n, "out_bits");
            let Ok(bits) = u32::try_from(*v) else {
                return s.fail(
                    loc,
                    format!("step {n}: out_bits must be between 0 and 0xffffffff"),
                );
            };
            if bits & !VALID_DIO_MASK != 0 {
                return s.fail(
                    loc,
                    format!("step {n}: out_bits 0x{bits:08x} has bits outside VALID_DIO_MASK"),
                );
            }
            Ok(bits)
        }
        (None, Some(_)) => s.fail(
            Loc::StepKey(n, "out_bits"),
            format!("step {n}: out_bits must be an integer"),
        ),
    }
}
