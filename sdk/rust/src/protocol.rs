//! Command builders and typed response parsers for the CDC text protocol.
//!
//! All functions here are pure (no I/O) so every parser can be unit-tested
//! without a device. Transport-level framing (line reads, counted reads)
//! lives in [`crate::transport`].

use crate::error::{Result, SdkError};
use crate::types::{
    Capabilities, EdgeMode, IoState, PatternMode, PatternState, PatternStatus, PatternStep, PinMap,
    PullMode, PushEvent, TimestampEvent, VersionInfo,
};

/// A single response line, classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response {
    /// `OK [data]` — data is everything after `OK ` (empty for bare `OK`).
    Ok(String),
    /// `ERR <code>` — code is everything after `ERR `.
    Err(String),
    /// `! <event>` — event is everything after `! `.
    Push(String),
}

impl Response {
    /// Extract the data of an `OK` response, mapping `ERR` codes to typed
    /// errors. A push line here is a routing bug, reported as a parse error.
    pub fn ok_data(self) -> Result<String> {
        match self {
            Response::Ok(data) => Ok(data),
            Response::Err(code) => Err(SdkError::from_error_code(&code)),
            Response::Push(ev) => Err(SdkError::Parse(format!(
                "unexpected push event in response position: ! {ev}"
            ))),
        }
    }
}

/// Classify one response line. Trailing CR/LF is tolerated.
pub fn parse_response(line: &str) -> Result<Response> {
    let line = line.trim_end_matches(['\r', '\n']);
    if let Some(rest) = line.strip_prefix("OK") {
        if rest.is_empty() {
            return Ok(Response::Ok(String::new()));
        }
        if let Some(data) = rest.strip_prefix(' ') {
            return Ok(Response::Ok(data.to_string()));
        }
        // e.g. "OKAY" — not an OK response
    } else if let Some(rest) = line.strip_prefix("ERR ") {
        return Ok(Response::Err(rest.to_string()));
    } else if let Some(rest) = line.strip_prefix("! ") {
        return Ok(Response::Push(rest.to_string()));
    }
    Err(SdkError::Parse(format!("unexpected response line: {line}")))
}

/// Extract `count=N` from an `OK` data string (e.g. `ts get` / `sync count`).
pub fn parse_count_field(ok_data: &str) -> Result<u64> {
    ok_data
        .split_whitespace()
        .find_map(|part| part.strip_prefix("count="))
        .ok_or_else(|| SdkError::Parse(format!("missing count= field: {ok_data}")))?
        .parse()
        .map_err(|_| SdkError::Parse(format!("invalid count= value: {ok_data}")))
}

/// Extract `count=N overflow=B` from a `ts get` `OK` data string.
///
/// `overflow=B` was added in FW v0.1.2 (Pochi-DIO `fix/cdc-tx-buffer-truncation`)
/// and signals that the ring buffer overflowed since the last `ts get`
/// (read-then-clear semantics on the FW side).
///
/// For backward compatibility with FW that does not emit the field, a
/// missing `overflow=` is treated as `overflow=0`.
pub fn parse_count_overflow_field(ok_data: &str) -> Result<(u64, bool)> {
    let count = parse_count_field(ok_data)?;
    let overflow = match ok_data
        .split_whitespace()
        .find_map(|part| part.strip_prefix("overflow="))
    {
        None => false,
        Some("0") => false,
        Some("1") => true,
        Some(other) => {
            return Err(SdkError::Parse(format!("invalid overflow= value: {other}")));
        }
    };
    Ok((count, overflow))
}

fn parse_u32_hex_or_dec(s: &str) -> Result<u32> {
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16).map_err(|_| SdkError::Parse(format!("invalid hex: {s}")))
    } else {
        s.parse()
            .map_err(|_| SdkError::Parse(format!("invalid number: {s}")))
    }
}

// --- version ---

/// Parse `v0.1.0 proto=1`.
pub fn parse_version(data: &str) -> Result<VersionInfo> {
    let mut semver: Option<(u8, u8, u8)> = None;
    let mut proto: Option<u8> = None;

    for part in data.split_whitespace() {
        if let Some(val) = part.strip_prefix("proto=") {
            proto = Some(
                val.parse()
                    .map_err(|_| SdkError::Parse(format!("invalid proto: {data}")))?,
            );
        } else if let Some(ver) = part.strip_prefix('v') {
            let nums: Vec<&str> = ver.split('.').collect();
            if nums.len() != 3 {
                return Err(SdkError::Parse(format!("invalid version: {part}")));
            }
            let parse = |s: &str| -> Result<u8> {
                s.parse()
                    .map_err(|_| SdkError::Parse(format!("invalid version: {part}")))
            };
            semver = Some((parse(nums[0])?, parse(nums[1])?, parse(nums[2])?));
        }
    }

    let (major, minor, patch) =
        semver.ok_or_else(|| SdkError::Parse(format!("missing version in: {data}")))?;
    let protocol_version =
        proto.ok_or_else(|| SdkError::Parse(format!("missing proto= in: {data}")))?;
    Ok(VersionInfo {
        major,
        minor,
        patch,
        protocol_version,
    })
}

// --- caps ---

/// Parse `dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000001`.
///
/// Old firmware (pre-Phase 9.6) reports `ts_res=1000`; it must fail loudly
/// because its `ts get` event format is incompatible.
pub fn parse_caps(data: &str) -> Result<Capabilities> {
    let mut dio = None;
    let mut out = None;
    let mut inp = None;
    let mut ts_res = None;
    let mut pattern = None;
    let mut ring = None;
    let mut feat = None;

    for part in data.split_whitespace() {
        let Some((key, val)) = part.split_once('=') else {
            continue;
        };
        let invalid = || SdkError::Parse(format!("invalid {key}= value in caps: {data}"));
        match key {
            "dio" => dio = Some(val.parse::<u8>().map_err(|_| invalid())?),
            "out" => out = Some(val.parse::<u8>().map_err(|_| invalid())?),
            "in" => inp = Some(val.parse::<u8>().map_err(|_| invalid())?),
            "ts_res" => {
                let ns = val.strip_suffix("ns").unwrap_or(val);
                ts_res = Some(ns.parse::<u32>().map_err(|_| invalid())?);
            }
            "pattern" => pattern = Some(val.parse::<u16>().map_err(|_| invalid())?),
            "ring" => ring = Some(val.parse::<u16>().map_err(|_| invalid())?),
            "feat" => feat = Some(parse_u32_hex_or_dec(val)?),
            "proto" => {} // not part of caps; tolerated if FW adds it
            _ => {}
        }
    }

    let missing = |k: &str| SdkError::Parse(format!("missing {k}= field in caps: {data}"));
    let caps = Capabilities {
        protocol_version: 0, // populated by the caller from `version`
        max_dio: dio.ok_or_else(|| missing("dio"))?,
        out_count: out.ok_or_else(|| missing("out"))?,
        in_count: inp.ok_or_else(|| missing("in"))?,
        ts_resolution_ns: ts_res.ok_or_else(|| missing("ts_res"))?,
        max_pattern_steps: pattern.ok_or_else(|| missing("pattern"))?,
        ts_ring_events: ring.ok_or_else(|| missing("ring"))?,
        features: feat.ok_or_else(|| missing("feat"))?,
    };

    if caps.ts_resolution_ns == 1000 {
        return Err(SdkError::UnsupportedFirmware(
            "caps reports ts_res=1000ns (pre-Phase 9.6 timestamp format)".to_string(),
        ));
    }
    Ok(caps)
}

// --- info ---

/// Parse `uid=AABBCCDD11223344 devnum=42`. devnum 255 maps to `None`.
pub fn parse_info(data: &str) -> Result<(String, Option<u8>)> {
    let mut uid = String::new();
    let mut devnum: Option<u8> = None;

    for part in data.split_whitespace() {
        if let Some(val) = part.strip_prefix("uid=") {
            uid = val.to_string();
        } else if let Some(val) = part.strip_prefix("devnum=") {
            let n: u16 = val
                .parse()
                .map_err(|_| SdkError::Parse(format!("invalid devnum: {data}")))?;
            devnum = if n == 255 { None } else { Some(n as u8) };
        }
    }

    if uid.is_empty() {
        return Err(SdkError::Parse(format!(
            "missing uid in info response: {data}"
        )));
    }
    Ok((uid, devnum))
}

// --- map ---

/// Parse `v=1 out=0:12 in=12:11 pull=up flags=0x01`.
pub fn parse_map(data: &str) -> Result<PinMap> {
    let mut version = None;
    let mut out = None;
    let mut inp = None;
    let mut pull = None;
    let mut flags = None;

    let parse_range = |val: &str, key: &str| -> Result<(u8, u8)> {
        let (base, count) = val
            .split_once(':')
            .ok_or_else(|| SdkError::Parse(format!("invalid {key}= range in map: {val}")))?;
        let base = base
            .parse()
            .map_err(|_| SdkError::Parse(format!("invalid {key}= base in map: {val}")))?;
        let count = count
            .parse()
            .map_err(|_| SdkError::Parse(format!("invalid {key}= count in map: {val}")))?;
        Ok((base, count))
    };

    for part in data.split_whitespace() {
        let Some((key, val)) = part.split_once('=') else {
            continue;
        };
        match key {
            "v" => {
                version = Some(
                    val.parse::<u8>()
                        .map_err(|_| SdkError::Parse(format!("invalid v= in map: {data}")))?,
                )
            }
            "out" => out = Some(parse_range(val, "out")?),
            "in" => inp = Some(parse_range(val, "in")?),
            "pull" => {
                pull = Some(match val {
                    "none" => PullMode::None,
                    "up" => PullMode::Up,
                    "down" => PullMode::Down,
                    other => {
                        return Err(SdkError::Parse(format!(
                            "invalid pull mode in map: {other}"
                        )))
                    }
                })
            }
            "flags" => flags = Some(parse_u32_hex_or_dec(val)? as u8),
            _ => {}
        }
    }

    let missing = |k: &str| SdkError::Parse(format!("missing {k}= field in map: {data}"));
    let (out_base, out_count) = out.ok_or_else(|| missing("out"))?;
    let (in_base, in_count) = inp.ok_or_else(|| missing("in"))?;
    Ok(PinMap {
        version: version.ok_or_else(|| missing("v"))?,
        out_base,
        out_count,
        in_base,
        in_count,
        pull: pull.ok_or_else(|| missing("pull"))?,
        flags: flags.ok_or_else(|| missing("flags"))?,
    })
}

/// Encode a [`PinMap`] as the 48-char hex string for `map set`.
///
/// Extended fields not represented in `PinMap` (out_default, polarities)
/// are zero. Use `map_set_hex` with TOML conversion to control them.
pub fn map_to_hex(map: &PinMap) -> String {
    let mut buf = [0u8; 24];
    buf[0] = map.version;
    buf[1] = map.out_base;
    buf[2] = map.out_count;
    buf[3] = map.in_base;
    buf[4] = map.in_count;
    buf[5] = match map.pull {
        PullMode::None => 0,
        PullMode::Up => 1,
        PullMode::Down => 2,
    };
    buf[6] = map.flags;
    hex::encode(buf)
}

// --- read / write / state ---

/// Parse the `read` response data: `0x000005`.
pub fn parse_read(data: &str) -> Result<u32> {
    parse_u32_hex_or_dec(data.trim())
}

/// Parse `in=0x000005 out=0x00000A flags=0x00`.
pub fn parse_state(data: &str) -> Result<IoState> {
    let mut inputs = None;
    let mut outputs = None;
    let mut flags = None;

    for part in data.split_whitespace() {
        let Some((key, val)) = part.split_once('=') else {
            continue;
        };
        match key {
            "in" => inputs = Some(parse_u32_hex_or_dec(val)?),
            "out" => outputs = Some(parse_u32_hex_or_dec(val)?),
            "flags" => flags = Some(parse_u32_hex_or_dec(val)? as u8),
            _ => {}
        }
    }

    let missing = |k: &str| SdkError::Parse(format!("missing {k}= field in state: {data}"));
    Ok(IoState {
        inputs: inputs.ok_or_else(|| missing("in"))?,
        outputs: outputs.ok_or_else(|| missing("out"))?,
        flags: flags.ok_or_else(|| missing("flags"))?,
    })
}

// --- pattern ---

/// Encode pattern steps for `pattern load`: step count (u16 LE) followed by
/// 8 bytes per step (out_bits u32 LE + hold_us u32 LE), hex-encoded.
pub fn pattern_to_hex(steps: &[PatternStep]) -> Result<String> {
    if steps.is_empty() {
        return Err(SdkError::Parse(
            "pattern must have at least one step".into(),
        ));
    }
    let count = u16::try_from(steps.len())
        .map_err(|_| SdkError::Parse(format!("too many pattern steps: {}", steps.len())))?;
    let mut data = Vec::with_capacity(2 + steps.len() * 8);
    data.extend_from_slice(&count.to_le_bytes());
    for step in steps {
        data.extend_from_slice(&step.out_bits.to_le_bytes());
        data.extend_from_slice(&step.hold_us.to_le_bytes());
    }
    Ok(hex::encode(data))
}

/// Parse `accepted=4` from the `pattern load` response.
pub fn parse_accepted(data: &str) -> Result<u16> {
    data.split_whitespace()
        .find_map(|part| part.strip_prefix("accepted="))
        .ok_or_else(|| SdkError::Parse(format!("missing accepted= field: {data}")))?
        .parse()
        .map_err(|_| SdkError::Parse(format!("invalid accepted= value: {data}")))
}

/// Build the `pattern run` command string.
pub fn pattern_run_command(mode: PatternMode, repeat: u16) -> String {
    match mode {
        PatternMode::Once => "pattern run once 1".to_string(),
        PatternMode::Loop => format!("pattern run loop {repeat}"),
    }
}

/// Parse `state=running step=5 loops=3`.
pub fn parse_pattern_status(data: &str) -> Result<PatternStatus> {
    let mut state = None;
    let mut step = None;
    let mut loops = None;

    for part in data.split_whitespace() {
        let Some((key, val)) = part.split_once('=') else {
            continue;
        };
        let invalid = || SdkError::Parse(format!("invalid {key}= value in pattern status: {data}"));
        match key {
            "state" => {
                state = Some(match val {
                    "idle" => PatternState::Idle,
                    "loaded" => PatternState::Loaded,
                    "running" => PatternState::Running,
                    "done" => PatternState::Done,
                    other => {
                        return Err(SdkError::Parse(format!("unknown pattern state: {other}")))
                    }
                })
            }
            "step" => step = Some(val.parse::<u16>().map_err(|_| invalid())?),
            "loops" => loops = Some(val.parse::<u16>().map_err(|_| invalid())?),
            _ => {}
        }
    }

    let missing =
        |k: &str| SdkError::Parse(format!("missing {k}= field in pattern status: {data}"));
    Ok(PatternStatus {
        state: state.ok_or_else(|| missing("state"))?,
        current_step: step.ok_or_else(|| missing("step"))?,
        loops_done: loops.ok_or_else(|| missing("loops"))?,
    })
}

// --- timestamp ---

/// Build the `ts arm` command string.
pub fn ts_arm_command(mask: u32, mode: EdgeMode) -> String {
    let mode = match mode {
        EdgeMode::Rising => "rising",
        EdgeMode::Falling => "falling",
        EdgeMode::Both => "both",
    };
    format!("ts arm {mask:#x} {mode}")
}

/// Parse one `ts get` event line (FW Phase 9.6 format):
/// `0x00000005 c=1000 p=7 s=1`.
///
/// The pre-9.6 format (`0x00000005 t=1234`) is detected explicitly and
/// rejected as [`SdkError::UnsupportedFirmware`] — never parsed silently.
pub fn parse_ts_event_line(line: &str) -> Result<TimestampEvent> {
    let trimmed = line.trim();
    let mut inputs: Option<u32> = None;
    let mut raw_count: Option<u32> = None;
    let mut raw_phase: Option<u8> = None;
    let mut sync_active: Option<bool> = None;
    let mut legacy_t = false;

    for part in trimmed.split_whitespace() {
        if part.starts_with("0x") || part.starts_with("0X") {
            inputs = Some(parse_u32_hex_or_dec(part)?);
        } else if let Some(val) = part.strip_prefix("c=") {
            raw_count = Some(
                val.parse()
                    .map_err(|_| SdkError::Parse(format!("invalid c= in ts event: {trimmed}")))?,
            );
        } else if let Some(val) = part.strip_prefix("p=") {
            raw_phase = Some(
                val.parse()
                    .map_err(|_| SdkError::Parse(format!("invalid p= in ts event: {trimmed}")))?,
            );
        } else if let Some(val) = part.strip_prefix("s=") {
            sync_active = Some(match val {
                "0" => false,
                "1" => true,
                other => return Err(SdkError::Parse(format!("invalid s= in ts event: {other}"))),
            });
        } else if part.starts_with("t=") {
            legacy_t = true;
        }
    }

    if legacy_t && raw_count.is_none() {
        return Err(SdkError::UnsupportedFirmware(format!(
            "ts event uses pre-Phase 9.6 `t=` format: {trimmed}"
        )));
    }

    let missing = |k: &str| SdkError::Parse(format!("missing {k} field in ts event: {trimmed}"));
    let inputs = inputs.ok_or_else(|| missing("inputs (0x...)"))?;
    let raw_count = raw_count.ok_or_else(|| missing("c="))?;
    let raw_phase = raw_phase.ok_or_else(|| missing("p="))?;
    let sync_active = sync_active.ok_or_else(|| missing("s="))?;

    Ok(TimestampEvent {
        inputs,
        raw_count,
        raw_phase,
        sync_active,
        timestamp_ns: crate::reconcile::as_is_ns(raw_count, raw_phase),
    })
}

// --- sync ---

/// Parse the `sync count` response data: `count=1000000`.
pub fn parse_sync_count(data: &str) -> Result<u64> {
    parse_count_field(data)
}

// --- push events ---

/// Parse the payload of a push line (after `! `).
///
/// Unknown event types are preserved as [`PushEvent::Unknown`] rather than
/// dropped, so forward-compatible callers can still observe them.
pub fn parse_push_event(payload: &str) -> Result<PushEvent> {
    let trimmed = payload.trim();
    let (kind, rest) = trimmed.split_once(' ').unwrap_or((trimmed, ""));

    match kind {
        "INPUT" => {
            let mut inputs: Option<u32> = None;
            let mut timestamp_us: Option<u64> = None;
            for part in rest.split_whitespace() {
                if part.starts_with("0x") || part.starts_with("0X") {
                    inputs = Some(parse_u32_hex_or_dec(part)?);
                } else if let Some(val) = part.strip_prefix("t=") {
                    timestamp_us = Some(val.parse().map_err(|_| {
                        SdkError::Parse(format!("invalid t= in INPUT event: {trimmed}"))
                    })?);
                }
            }
            let missing =
                |k: &str| SdkError::Parse(format!("missing {k} in INPUT event: {trimmed}"));
            Ok(PushEvent::InputChange {
                inputs: inputs.ok_or_else(|| missing("inputs (0x...)"))?,
                timestamp_us: timestamp_us.ok_or_else(|| missing("t="))?,
            })
        }
        "PATTERN_DONE" => {
            let loops = rest
                .split_whitespace()
                .find_map(|p| p.strip_prefix("loops="))
                .ok_or_else(|| {
                    SdkError::Parse(format!("missing loops= in PATTERN_DONE event: {trimmed}"))
                })?
                .parse()
                .map_err(|_| {
                    SdkError::Parse(format!("invalid loops= in PATTERN_DONE event: {trimmed}"))
                })?;
            Ok(PushEvent::PatternDone { loops })
        }
        "SYNC_DONE" => {
            let mut status = None;
            let mut devnum = None;
            let mut ts = None;
            for part in rest.split_whitespace() {
                let invalid = |k: &str| {
                    SdkError::Parse(format!("invalid {k}= in SYNC_DONE event: {trimmed}"))
                };
                if let Some(val) = part.strip_prefix("status=") {
                    status = Some(val.to_string());
                } else if let Some(val) = part.strip_prefix("devnum=") {
                    devnum = Some(val.parse::<u8>().map_err(|_| invalid("devnum"))?);
                } else if let Some(val) = part.strip_prefix("ts=") {
                    ts = Some(val.parse::<u64>().map_err(|_| invalid("ts"))?);
                }
            }
            let missing =
                |k: &str| SdkError::Parse(format!("missing {k}= in SYNC_DONE event: {trimmed}"));
            Ok(PushEvent::SyncDone {
                status: status.ok_or_else(|| missing("status"))?,
                devnum: devnum.ok_or_else(|| missing("devnum"))?,
                timestamp: ts.ok_or_else(|| missing("ts"))?,
            })
        }
        _ => Ok(PushEvent::Unknown {
            raw: trimmed.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert_matches::assert_matches;

    // --- parse_response ---

    #[test]
    fn response_ok_empty() {
        assert_eq!(
            parse_response("OK\r\n").unwrap(),
            Response::Ok(String::new())
        );
    }

    #[test]
    fn response_ok_data() {
        assert_eq!(
            parse_response("OK v0.1.0 proto=1\r\n").unwrap(),
            Response::Ok("v0.1.0 proto=1".into())
        );
    }

    #[test]
    fn response_err() {
        assert_eq!(
            parse_response("ERR BAD_CMD\r\n").unwrap(),
            Response::Err("BAD_CMD".into())
        );
    }

    #[test]
    fn response_push() {
        assert_eq!(
            parse_response("! INPUT 0x05 t=99\r\n").unwrap(),
            Response::Push("INPUT 0x05 t=99".into())
        );
    }

    #[test]
    fn response_garbage_rejected() {
        assert_matches!(parse_response("garbage"), Err(SdkError::Parse(_)));
        assert_matches!(parse_response("OKAY nope"), Err(SdkError::Parse(_)));
        assert_matches!(parse_response(""), Err(SdkError::Parse(_)));
    }

    #[test]
    fn ok_data_maps_err_codes() {
        assert_matches!(Response::Err("BUSY".into()).ok_data(), Err(SdkError::Busy));
        assert_matches!(
            Response::Err("WHAT".into()).ok_data(),
            Err(SdkError::UnknownDevice(_))
        );
        assert_matches!(
            Response::Push("INPUT".into()).ok_data(),
            Err(SdkError::Parse(_))
        );
    }

    // --- count field ---

    #[test]
    fn count_field_basic() {
        assert_eq!(parse_count_field("count=2").unwrap(), 2);
        assert_eq!(parse_count_field("count=0").unwrap(), 0);
        assert_eq!(parse_count_field("count=1000000").unwrap(), 1_000_000);
    }

    #[test]
    fn count_field_missing_or_bad() {
        assert_matches!(parse_count_field("n=2"), Err(SdkError::Parse(_)));
        assert_matches!(parse_count_field("count=abc"), Err(SdkError::Parse(_)));
        assert_matches!(parse_count_field("count=-1"), Err(SdkError::Parse(_)));
    }

    #[test]
    fn count_overflow_field_new_fw() {
        assert_eq!(
            parse_count_overflow_field("count=3 overflow=0").unwrap(),
            (3, false)
        );
        assert_eq!(
            parse_count_overflow_field("count=85 overflow=1").unwrap(),
            (85, true)
        );
    }

    #[test]
    fn count_overflow_field_old_fw_missing_field() {
        // FW without the overflow= field is treated as overflow=false.
        assert_eq!(parse_count_overflow_field("count=3").unwrap(), (3, false));
        assert_eq!(parse_count_overflow_field("count=0").unwrap(), (0, false));
    }

    #[test]
    fn count_overflow_field_field_order_independent() {
        assert_eq!(
            parse_count_overflow_field("overflow=1 count=4").unwrap(),
            (4, true)
        );
    }

    #[test]
    fn count_overflow_field_invalid_value() {
        assert_matches!(
            parse_count_overflow_field("count=1 overflow=2"),
            Err(SdkError::Parse(_))
        );
        assert_matches!(
            parse_count_overflow_field("count=1 overflow=yes"),
            Err(SdkError::Parse(_))
        );
        // count= still required even with overflow= present.
        assert_matches!(
            parse_count_overflow_field("overflow=0"),
            Err(SdkError::Parse(_))
        );
    }

    // --- version ---

    #[test]
    fn version_basic() {
        let v = parse_version("v0.1.0 proto=1").unwrap();
        assert_eq!(
            (v.major, v.minor, v.patch, v.protocol_version),
            (0, 1, 0, 1)
        );
    }

    #[test]
    fn version_multi_digit() {
        let v = parse_version("v12.34.56 proto=2").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (12, 34, 56));
    }

    #[test]
    fn version_malformed() {
        assert_matches!(parse_version("proto=1"), Err(SdkError::Parse(_)));
        assert_matches!(parse_version("v0.1.0"), Err(SdkError::Parse(_)));
        assert_matches!(parse_version("v0.1 proto=1"), Err(SdkError::Parse(_)));
        assert_matches!(parse_version("vX.Y.Z proto=1"), Err(SdkError::Parse(_)));
        assert_matches!(parse_version(""), Err(SdkError::Parse(_)));
    }

    // --- caps ---

    #[test]
    fn caps_basic() {
        let c = parse_caps("dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000001")
            .unwrap();
        assert_eq!(c.max_dio, 23);
        assert_eq!(c.out_count, 12);
        assert_eq!(c.in_count, 11);
        assert_eq!(c.ts_resolution_ns, 40);
        assert_eq!(c.max_pattern_steps, 256);
        assert_eq!(c.ts_ring_events, 256);
        assert_eq!(c.features, 1);
        assert!(c.has_sync());
    }

    #[test]
    fn caps_zero_outputs() {
        let c = parse_caps("dio=23 out=0 in=23 ts_res=40ns pattern=256 ring=256 feat=0x00000000")
            .unwrap();
        assert_eq!(c.out_count, 0);
        assert!(!c.has_sync());
    }

    #[test]
    fn caps_old_firmware_rejected() {
        // ts_res=1000 marks pre-Phase 9.6 firmware: must fail loudly.
        let err =
            parse_caps("dio=23 out=12 in=11 ts_res=1000ns pattern=256 ring=256 feat=0x00000001")
                .unwrap_err();
        assert_matches!(err, SdkError::UnsupportedFirmware(_));
    }

    #[test]
    fn caps_missing_field() {
        assert_matches!(parse_caps("dio=23 out=12 in=11"), Err(SdkError::Parse(_)));
    }

    #[test]
    fn caps_malformed_value() {
        assert_matches!(
            parse_caps("dio=banana out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x1"),
            Err(SdkError::Parse(_))
        );
    }

    // --- info ---

    #[test]
    fn info_basic() {
        let (uid, devnum) = parse_info("uid=AABBCCDD11223344 devnum=42").unwrap();
        assert_eq!(uid, "AABBCCDD11223344");
        assert_eq!(devnum, Some(42));
    }

    #[test]
    fn info_unassigned() {
        let (_, devnum) = parse_info("uid=AABBCCDD11223344 devnum=255").unwrap();
        assert_eq!(devnum, None);
    }

    #[test]
    fn info_missing_uid() {
        assert_matches!(parse_info("devnum=1"), Err(SdkError::Parse(_)));
    }

    #[test]
    fn info_bad_devnum() {
        assert_matches!(parse_info("uid=AABB devnum=zzz"), Err(SdkError::Parse(_)));
    }

    // --- map ---

    #[test]
    fn map_basic() {
        let m = parse_map("v=1 out=0:12 in=12:11 pull=up flags=0x01").unwrap();
        assert_eq!(m.version, 1);
        assert_eq!((m.out_base, m.out_count), (0, 12));
        assert_eq!((m.in_base, m.in_count), (12, 11));
        assert_eq!(m.pull, PullMode::Up);
        assert_eq!(m.flags, 0x01);
    }

    #[test]
    fn map_all_input() {
        let m = parse_map("v=1 out=0:0 in=0:23 pull=down flags=0x01").unwrap();
        assert_eq!(m.out_count, 0);
        assert_eq!(m.in_count, 23);
        assert_eq!(m.pull, PullMode::Down);
    }

    #[test]
    fn map_bad_pull() {
        assert_matches!(
            parse_map("v=1 out=0:0 in=0:23 pull=sideways flags=0x01"),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn map_missing_field() {
        assert_matches!(parse_map("v=1 out=0:12"), Err(SdkError::Parse(_)));
    }

    #[test]
    fn map_bad_range() {
        assert_matches!(
            parse_map("v=1 out=012 in=0:23 pull=up flags=0x01"),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn map_round_trip_hex() {
        let map = PinMap {
            version: 1,
            out_base: 0,
            out_count: 12,
            in_base: 12,
            in_count: 11,
            pull: PullMode::Up,
            flags: 0x01,
        };
        let hex = map_to_hex(&map);
        assert_eq!(hex.len(), 48);
        let bytes = hex::decode(&hex).unwrap();
        assert_eq!(&bytes[0..7], &[1, 0, 12, 12, 11, 1, 1]);
        assert!(bytes[7..].iter().all(|&b| b == 0));
    }

    // --- read / state ---

    #[test]
    fn read_basic() {
        assert_eq!(parse_read("0x000005").unwrap(), 5);
        assert_eq!(parse_read(" 0x0 ").unwrap(), 0);
        assert_eq!(parse_read("0x7FFFFF").unwrap(), 0x7FFFFF);
    }

    #[test]
    fn read_malformed() {
        assert_matches!(parse_read("five"), Err(SdkError::Parse(_)));
        assert_matches!(parse_read(""), Err(SdkError::Parse(_)));
    }

    #[test]
    fn state_basic() {
        let s = parse_state("in=0x000005 out=0x00000A flags=0x00").unwrap();
        assert_eq!(s.inputs, 5);
        assert_eq!(s.outputs, 10);
        assert_eq!(s.flags, 0);
    }

    #[test]
    fn state_overflow_flag() {
        let s = parse_state("in=0x0 out=0x0 flags=0x01").unwrap();
        assert_eq!(s.flags, 1);
    }

    #[test]
    fn state_missing_field() {
        assert_matches!(parse_state("in=0x05 out=0x0A"), Err(SdkError::Parse(_)));
    }

    // --- pattern ---

    #[test]
    fn pattern_hex_count_prefix() {
        // FW expects a u16 LE step count before the step data (protocol §6.3).
        let steps = vec![
            PatternStep {
                out_bits: 0x0F,
                hold_us: 100,
            },
            PatternStep {
                out_bits: 0x00,
                hold_us: 200,
            },
        ];
        let hex = pattern_to_hex(&steps).unwrap();
        let bytes = hex::decode(&hex).unwrap();
        assert_eq!(bytes.len(), 2 + 2 * 8);
        assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), 2);
        assert_eq!(
            u32::from_le_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]),
            0x0F
        );
        assert_eq!(
            u32::from_le_bytes([bytes[6], bytes[7], bytes[8], bytes[9]]),
            100
        );
    }

    #[test]
    fn pattern_hex_empty_rejected() {
        assert_matches!(pattern_to_hex(&[]), Err(SdkError::Parse(_)));
    }

    #[test]
    fn pattern_accepted() {
        assert_eq!(parse_accepted("accepted=4").unwrap(), 4);
        assert_matches!(parse_accepted("ok"), Err(SdkError::Parse(_)));
        assert_matches!(parse_accepted("accepted=x"), Err(SdkError::Parse(_)));
    }

    #[test]
    fn pattern_run_commands() {
        assert_eq!(
            pattern_run_command(PatternMode::Once, 1),
            "pattern run once 1"
        );
        assert_eq!(
            pattern_run_command(PatternMode::Loop, 10),
            "pattern run loop 10"
        );
        assert_eq!(
            pattern_run_command(PatternMode::Loop, 0),
            "pattern run loop 0"
        );
    }

    #[test]
    fn pattern_status_basic() {
        let s = parse_pattern_status("state=running step=5 loops=3").unwrap();
        assert_eq!(s.state, PatternState::Running);
        assert_eq!(s.current_step, 5);
        assert_eq!(s.loops_done, 3);
    }

    #[test]
    fn pattern_status_all_states() {
        assert_eq!(
            parse_pattern_status("state=idle step=0 loops=0")
                .unwrap()
                .state,
            PatternState::Idle
        );
        assert_eq!(
            parse_pattern_status("state=done step=9 loops=1")
                .unwrap()
                .state,
            PatternState::Done
        );
        assert_eq!(
            parse_pattern_status("state=loaded step=0 loops=0")
                .unwrap()
                .state,
            PatternState::Loaded
        );
    }

    #[test]
    fn pattern_status_unknown_state() {
        assert_matches!(
            parse_pattern_status("state=paused step=0 loops=0"),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn pattern_status_missing_field() {
        assert_matches!(parse_pattern_status("state=idle"), Err(SdkError::Parse(_)));
    }

    // --- timestamp ---

    #[test]
    fn ts_arm_commands() {
        assert_eq!(
            ts_arm_command(0x07FF, EdgeMode::Rising),
            "ts arm 0x7ff rising"
        );
        assert_eq!(ts_arm_command(1, EdgeMode::Falling), "ts arm 0x1 falling");
        assert_eq!(ts_arm_command(0xFF, EdgeMode::Both), "ts arm 0xff both");
    }

    #[test]
    fn ts_event_basic() {
        let ev = parse_ts_event_line("  0x00000005 c=1000 p=7 s=1").unwrap();
        assert_eq!(ev.inputs, 5);
        assert_eq!(ev.raw_count, 1000);
        assert_eq!(ev.raw_phase, 7);
        assert!(ev.sync_active);
        assert_eq!(ev.timestamp_ns, 1_000_280);
    }

    #[test]
    fn ts_event_free_running() {
        let ev = parse_ts_event_line("0x00000001 c=500 p=0 s=0").unwrap();
        assert!(!ev.sync_active);
        assert_eq!(ev.timestamp_ns, 500_000);
    }

    #[test]
    fn ts_event_phase_max() {
        let ev = parse_ts_event_line("0x1 c=0 p=24 s=1").unwrap();
        assert_eq!(ev.timestamp_ns, 960);
    }

    #[test]
    fn ts_event_old_format_unsupported_firmware() {
        // The pre-9.6 `t=` format must surface as UnsupportedFirmware,
        // not a generic parse error and never a silent parse.
        let err = parse_ts_event_line("0x00000005 t=1234567890").unwrap_err();
        assert_matches!(err, SdkError::UnsupportedFirmware(_));
    }

    #[test]
    fn ts_event_missing_fields() {
        assert_matches!(
            parse_ts_event_line("0x05 c=1000 p=7"),
            Err(SdkError::Parse(_))
        );
        assert_matches!(
            parse_ts_event_line("c=1000 p=7 s=1"),
            Err(SdkError::Parse(_))
        );
        assert_matches!(parse_ts_event_line(""), Err(SdkError::Parse(_)));
    }

    #[test]
    fn ts_event_bad_sync_flag() {
        assert_matches!(
            parse_ts_event_line("0x05 c=1000 p=7 s=2"),
            Err(SdkError::Parse(_))
        );
    }

    // --- sync ---

    #[test]
    fn sync_count_basic() {
        assert_eq!(parse_sync_count("count=1000000").unwrap(), 1_000_000);
    }

    #[test]
    fn sync_count_malformed() {
        assert_matches!(parse_sync_count("1000000"), Err(SdkError::Parse(_)));
    }

    // --- push events ---

    #[test]
    fn push_input_change() {
        let ev = parse_push_event("INPUT 0x000005 t=1234567890").unwrap();
        assert_matches!(
            ev,
            PushEvent::InputChange {
                inputs: 5,
                timestamp_us: 1234567890
            }
        );
    }

    #[test]
    fn push_pattern_done() {
        let ev = parse_push_event("PATTERN_DONE loops=10").unwrap();
        assert_matches!(ev, PushEvent::PatternDone { loops: 10 });
    }

    #[test]
    fn push_sync_done() {
        let ev = parse_push_event("SYNC_DONE status=ready devnum=1 ts=12345").unwrap();
        assert_matches!(
            ev,
            PushEvent::SyncDone { ref status, devnum: 1, timestamp: 12345 } if status == "ready"
        );
    }

    #[test]
    fn push_unknown_preserved() {
        let ev = parse_push_event("FUTURE_EVENT data=1").unwrap();
        assert_matches!(ev, PushEvent::Unknown { ref raw } if raw == "FUTURE_EVENT data=1");
    }

    #[test]
    fn push_input_malformed() {
        assert_matches!(parse_push_event("INPUT t=99"), Err(SdkError::Parse(_)));
        assert_matches!(parse_push_event("INPUT 0x05"), Err(SdkError::Parse(_)));
        assert_matches!(
            parse_push_event("PATTERN_DONE loops=abc"),
            Err(SdkError::Parse(_))
        );
    }
}
