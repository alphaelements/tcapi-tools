//! TOML configuration for pin maps and patterns (host-side convenience).
//!
//! Formats follow `docs/protocol-reference.md` §10/§11. Map TOML converts
//! to the full 24-byte hex (including out_default / polarities, which the
//! typed [`crate::types::PinMap`] does not carry) for `map set`. Pattern
//! TOML converts to typed steps; an edge list is expanded to steps.

use serde::Deserialize;

use crate::error::{Result, SdkError};
use crate::types::PatternStep;

const MAX_PATTERN_STEPS: usize = 256;

fn invalid(msg: impl Into<String>) -> SdkError {
    SdkError::Parse(msg.into())
}

// --- pin map ---

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MapConfig {
    version: Option<u8>,
    output: Option<MapOutputConfig>,
    input: Option<MapInputConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MapOutputConfig {
    base: Option<u8>,
    count: Option<u8>,
    default: Option<u32>,
    polarity: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MapInputConfig {
    base: Option<u8>,
    count: Option<u8>,
    pull: Option<String>,
    timestamp: Option<bool>,
    polarity: Option<u32>,
}

/// Convert map TOML to the 48-char hex string for `map set`.
pub fn map_toml_to_hex(toml_str: &str) -> Result<String> {
    let config: MapConfig =
        toml::from_str(toml_str).map_err(|e| invalid(format!("failed to parse map TOML: {e}")))?;

    let mut buf = [0u8; 24];
    buf[0] = config.version.unwrap_or(1);

    if let Some(out) = &config.output {
        buf[1] = out.base.unwrap_or(0);
        buf[2] = out.count.unwrap_or(0);
        buf[8..12].copy_from_slice(&out.default.unwrap_or(0).to_le_bytes());
        buf[12..16].copy_from_slice(&out.polarity.unwrap_or(0).to_le_bytes());
    }

    if let Some(inp) = &config.input {
        buf[3] = inp.base.unwrap_or(0);
        buf[4] = inp.count.unwrap_or(0);
        buf[5] = match inp.pull.as_deref() {
            Some("none") => 0,
            Some("up") => 1,
            Some("down") | None => 2,
            Some(other) => return Err(invalid(format!("invalid pull value: {other}"))),
        };
        let mut flags = 0u8;
        if inp.timestamp.unwrap_or(false) {
            flags |= 0x01;
        }
        buf[6] = flags;
        buf[16..20].copy_from_slice(&inp.polarity.unwrap_or(0).to_le_bytes());
    }

    Ok(hex::encode(buf))
}

// --- pattern ---

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PatternConfig {
    version: Option<u8>,
    unit: Option<String>,
    steps: Option<Vec<TomlStep>>,
    edge: Option<Vec<EdgeEvent>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TomlStep {
    out: u32,
    hold: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EdgeEvent {
    ch: u8,
    t: u64,
    level: u8,
}

/// Convert pattern TOML to typed steps. Accepts either a `steps` list or
/// an `edge` list (expanded host-side, per protocol §6).
pub fn pattern_toml_to_steps(toml_str: &str) -> Result<Vec<PatternStep>> {
    let config: PatternConfig = toml::from_str(toml_str)
        .map_err(|e| invalid(format!("failed to parse pattern TOML: {e}")))?;

    if let Some(v) = config.version {
        if v != 1 {
            return Err(invalid(format!("unsupported pattern TOML version: {v}")));
        }
    }
    if let Some(unit) = &config.unit {
        if unit != "us" {
            return Err(invalid(format!(
                "unsupported pattern time unit: {unit} (only \"us\")"
            )));
        }
    }

    let steps: Vec<PatternStep> = if let Some(steps) = config.steps {
        steps
            .into_iter()
            .map(|s| PatternStep {
                out_bits: s.out,
                hold_us: s.hold,
            })
            .collect()
    } else if let Some(edges) = config.edge {
        edges_to_steps(&edges)?
    } else {
        return Err(invalid("pattern TOML must contain 'steps' or 'edge'"));
    };

    if steps.is_empty() {
        return Err(invalid("pattern must have at least one step"));
    }
    if steps.len() > MAX_PATTERN_STEPS {
        return Err(invalid(format!(
            "pattern exceeds maximum {MAX_PATTERN_STEPS} steps"
        )));
    }
    Ok(steps)
}

fn edges_to_steps(edges: &[EdgeEvent]) -> Result<Vec<PatternStep>> {
    if edges.is_empty() {
        return Err(invalid("edge list is empty"));
    }
    for edge in edges {
        if edge.level > 1 {
            return Err(invalid(format!(
                "invalid edge level {} (must be 0 or 1)",
                edge.level
            )));
        }
        if edge.ch > 31 {
            return Err(invalid(format!("invalid edge channel {}", edge.ch)));
        }
    }

    let mut sorted: Vec<&EdgeEvent> = edges.iter().collect();
    sorted.sort_by_key(|e| e.t);

    let mut timepoints: Vec<u64> = sorted.iter().map(|e| e.t).collect();
    timepoints.dedup();

    let mut steps = Vec::new();
    let mut current_bits: u32 = 0;

    for (i, &t) in timepoints.iter().enumerate() {
        for edge in &sorted {
            if edge.t == t {
                if edge.level != 0 {
                    current_bits |= 1 << edge.ch;
                } else {
                    current_bits &= !(1 << edge.ch);
                }
            }
        }

        let hold = if i + 1 < timepoints.len() {
            u32::try_from(timepoints[i + 1] - t)
                .map_err(|_| invalid("edge time gap exceeds u32 µs range"))?
        } else {
            0
        };

        if hold > 0 || i + 1 == timepoints.len() {
            steps.push(PatternStep {
                out_bits: current_bits,
                hold_us: hold,
            });
        }
    }

    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert_matches::assert_matches;

    #[test]
    fn map_all_input() {
        let toml = r#"
version = 1
[input]
base = 0
count = 23
pull = "down"
timestamp = true
"#;
        let hex = map_toml_to_hex(toml).unwrap();
        assert_eq!(hex.len(), 48);
        let bytes = hex::decode(&hex).unwrap();
        assert_eq!(&bytes[0..7], &[1, 0, 0, 0, 23, 2, 1]);
    }

    #[test]
    fn map_output_12_input_11() {
        let toml = r#"
version = 1
[output]
base = 0
count = 12
default = 0x0F
polarity = 0x03

[input]
base = 12
count = 11
pull = "up"
timestamp = true
"#;
        let bytes = hex::decode(map_toml_to_hex(toml).unwrap()).unwrap();
        assert_eq!(&bytes[0..7], &[1, 0, 12, 12, 11, 1, 1]);
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 0x0F);
        assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 0x03);
    }

    #[test]
    fn map_output_only() {
        let toml = r#"
[output]
base = 0
count = 23
"#;
        let bytes = hex::decode(map_toml_to_hex(toml).unwrap()).unwrap();
        assert_eq!(bytes[2], 23);
        assert_eq!(bytes[4], 0);
    }

    #[test]
    fn map_bad_pull_rejected() {
        let toml = r#"
[input]
base = 0
count = 23
pull = "sideways"
"#;
        assert_matches!(map_toml_to_hex(toml), Err(SdkError::Parse(_)));
    }

    #[test]
    fn map_unknown_key_rejected() {
        let toml = r#"
[input]
base = 0
count = 23
plul = "up"
"#;
        assert_matches!(map_toml_to_hex(toml), Err(SdkError::Parse(_)));
    }

    #[test]
    fn map_not_toml_rejected() {
        assert_matches!(map_toml_to_hex("{json: false}"), Err(SdkError::Parse(_)));
    }

    #[test]
    fn pattern_steps_basic() {
        let toml = r#"
version = 1
unit = "us"
steps = [
  { out = 1, hold = 100 },
  { out = 2, hold = 100 },
  { out = 0, hold = 200 },
]
"#;
        let steps = pattern_toml_to_steps(toml).unwrap();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].out_bits, 1);
        assert_eq!(steps[0].hold_us, 100);
        assert_eq!(steps[2].hold_us, 200);
    }

    #[test]
    fn pattern_edges_expanded() {
        let toml = r#"
[[edge]]
ch = 0
t = 0
level = 1

[[edge]]
ch = 0
t = 100
level = 0

[[edge]]
ch = 1
t = 50
level = 1

[[edge]]
ch = 1
t = 150
level = 0
"#;
        let steps = pattern_toml_to_steps(toml).unwrap();
        assert_eq!(steps.len(), 4);
        assert_eq!((steps[0].out_bits, steps[0].hold_us), (0b01, 50));
        assert_eq!((steps[1].out_bits, steps[1].hold_us), (0b11, 50));
        assert_eq!((steps[2].out_bits, steps[2].hold_us), (0b10, 50));
        assert_eq!((steps[3].out_bits, steps[3].hold_us), (0b00, 0));
    }

    #[test]
    fn pattern_empty_rejected() {
        assert_matches!(
            pattern_toml_to_steps("version = 1"),
            Err(SdkError::Parse(_))
        );
        assert_matches!(pattern_toml_to_steps("steps = []"), Err(SdkError::Parse(_)));
    }

    #[test]
    fn pattern_too_many_steps_rejected() {
        let steps: Vec<String> = (0..257).map(|_| "{ out = 1, hold = 1 }".into()).collect();
        let toml = format!("steps = [{}]", steps.join(", "));
        assert_matches!(pattern_toml_to_steps(&toml), Err(SdkError::Parse(_)));
    }

    #[test]
    fn pattern_bad_edge_level_rejected() {
        let toml = r#"
[[edge]]
ch = 0
t = 0
level = 2
"#;
        assert_matches!(pattern_toml_to_steps(toml), Err(SdkError::Parse(_)));
    }

    #[test]
    fn pattern_round_trip_through_hex() {
        let steps = pattern_toml_to_steps(
            r#"steps = [{ out = 0x0F, hold = 100 }, { out = 0, hold = 100 }]"#,
        )
        .unwrap();
        let hex = crate::protocol::pattern_to_hex(&steps).unwrap();
        // u16 count + 2 steps x 8 bytes = 18 bytes = 36 hex chars
        assert_eq!(hex.len(), 36);
    }
}
