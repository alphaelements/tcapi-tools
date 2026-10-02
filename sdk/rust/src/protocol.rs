//! Command builders and typed response parsers for the v2 CDC text protocol.
//!
//! All functions here are pure (no I/O) so every parser can be unit-tested
//! without a device. Transport-level framing (line reads, counted reads)
//! lives in [`crate::transport`].
//!
//! Parsers are strict (R-P6): a response must carry exactly the documented
//! keys, no more and no fewer, and numbers must be in range. Anything else is
//! an [`SdkError::Parse`], never a silently defaulted value.

use crate::error::{Result, SdkError};
use crate::types::{
    check_dio_mask, Capabilities, EdgeMode, IoState, PatternMode, PatternState, PatternStatus,
    PatternStep, PinMap, PushEvent, TimestampEvent, TsStatus, VersionInfo,
};

/// Longest request line the device accepts, excluding the CR/LF terminator
/// (R-T1).
pub const MAX_LINE_BYTES: usize = 256;

/// Highest valid `p=` (raw phase) value of a timestamp event.
const MAX_RAW_PHASE: u8 = 24;

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

/// Extract `count=N` from the header of a counted multi-line response
/// (`ts get`, `help`).
pub fn parse_count_field(ok_data: &str) -> Result<u64> {
    ok_data
        .split_whitespace()
        .find_map(|part| part.strip_prefix("count="))
        .ok_or_else(|| SdkError::Parse(format!("missing count= field: {ok_data}")))?
        .parse()
        .map_err(|_| SdkError::Parse(format!("invalid count= value: {ok_data}")))
}

// --- key=value field parsing ---

/// Parse a number given as decimal or `0x` hex. Digits only: no sign, no
/// whitespace, no empty digit string.
fn parse_u32_hex_or_dec(s: &str) -> Result<u32> {
    let invalid = |what: &str| SdkError::Parse(format!("invalid {what}: {s}"));
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid("hex"));
        }
        u32::from_str_radix(hex, 16).map_err(|_| invalid("hex"))
    } else {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid("number"));
        }
        s.parse().map_err(|_| invalid("number"))
    }
}

/// The `key=value` fields of one response, checked against the exact key set
/// the protocol documents for it.
struct Fields<'a> {
    ctx: &'static str,
    data: &'a str,
    pairs: Vec<(&'a str, &'a str)>,
}

impl<'a> Fields<'a> {
    /// Split `data` into `key=value` tokens. Every key in `keys` must be
    /// present exactly once and no other key may appear (order is free).
    fn parse(ctx: &'static str, data: &'a str, keys: &[&str]) -> Result<Self> {
        let err = |msg: String| SdkError::Parse(format!("{msg} in {ctx}: {data}"));
        let mut pairs: Vec<(&str, &str)> = Vec::with_capacity(keys.len());
        for token in data.split_whitespace() {
            let (key, value) = token
                .split_once('=')
                .ok_or_else(|| err(format!("token without '=' ({token})")))?;
            if !keys.contains(&key) {
                return Err(err(format!("unexpected key {key}=")));
            }
            if pairs.iter().any(|(k, _)| *k == key) {
                return Err(err(format!("duplicate key {key}=")));
            }
            pairs.push((key, value));
        }
        if let Some(missing) = keys.iter().find(|k| !pairs.iter().any(|(pk, _)| pk == *k)) {
            return Err(err(format!("missing {missing}= field")));
        }
        Ok(Self { ctx, data, pairs })
    }

    fn raw(&self, key: &str) -> Result<&'a str> {
        self.pairs
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| *v)
            .ok_or_else(|| self.invalid(key))
    }

    fn invalid(&self, key: &str) -> SdkError {
        SdkError::Parse(format!(
            "invalid {key}= value in {}: {}",
            self.ctx, self.data
        ))
    }

    /// Plain decimal integer.
    fn dec<T: std::str::FromStr>(&self, key: &str) -> Result<T> {
        let raw = self.raw(key)?;
        if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
            return Err(self.invalid(key));
        }
        raw.parse().map_err(|_| self.invalid(key))
    }

    /// Mask or bit value: `0x` hex (canonical) or decimal.
    fn mask(&self, key: &str) -> Result<u32> {
        parse_u32_hex_or_dec(self.raw(key)?).map_err(|_| self.invalid(key))
    }

    fn u8_mask(&self, key: &str) -> Result<u8> {
        u8::try_from(self.mask(key)?).map_err(|_| self.invalid(key))
    }

    /// `0` or `1`.
    fn flag(&self, key: &str) -> Result<bool> {
        match self.raw(key)? {
            "0" => Ok(false),
            "1" => Ok(true),
            _ => Err(self.invalid(key)),
        }
    }
}

// --- version ---

/// Parse `fw=0.1.3 proto=2`.
///
/// The protocol number is returned as reported; callers decide whether it is
/// supported (see [`crate::types::PROTO_VERSION`]).
pub fn parse_version(data: &str) -> Result<VersionInfo> {
    let f = Fields::parse("version", data, &["fw", "proto"])?;
    let fw = f.raw("fw")?;
    let nums: Vec<&str> = fw.split('.').collect();
    let part = |s: &str| -> Result<u8> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(f.invalid("fw"));
        }
        s.parse().map_err(|_| f.invalid("fw"))
    };
    let [major, minor, patch] = nums.as_slice() else {
        return Err(f.invalid("fw"));
    };
    Ok(VersionInfo {
        major: part(major)?,
        minor: part(minor)?,
        patch: part(patch)?,
        protocol_version: f.dec("proto")?,
    })
}

// --- caps ---

/// Parse `dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=256 ring=256
/// feat=0x00000003`.
pub fn parse_caps(data: &str) -> Result<Capabilities> {
    let f = Fields::parse(
        "caps",
        data,
        &[
            "dio",
            "out",
            "in",
            "ts_res_ns",
            "tick_ns",
            "pattern",
            "ring",
            "feat",
        ],
    )?;
    Ok(Capabilities {
        dio: f.dec("dio")?,
        out: f.dec("out")?,
        r#in: f.dec("in")?,
        ts_res_ns: f.dec("ts_res_ns")?,
        tick_ns: f.dec("tick_ns")?,
        pattern_max: f.dec("pattern")?,
        ring: f.dec("ring")?,
        features: f.mask("feat")?,
    })
}

// --- info / devnum / ping ---

/// Parse `uid=0123456789ABCDEF devnum=42`. devnum 255 (unassigned) maps to
/// `None`.
pub fn parse_info(data: &str) -> Result<(String, Option<u8>)> {
    let f = Fields::parse("info", data, &["uid", "devnum"])?;
    let uid = f.raw("uid")?;
    if uid.len() != 16 || !uid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(f.invalid("uid"));
    }
    let devnum: u8 = f.dec("devnum")?;
    Ok((uid.to_string(), (devnum != 255).then_some(devnum)))
}

/// Parse the `ping` response `pong=<u32>`.
pub fn parse_pong(data: &str) -> Result<u32> {
    Fields::parse("ping", data, &["pong"])?.dec("pong")
}

// --- map ---

/// Parse the `map get` response `v=2 flags=0x00 dir=... edge=...` and
/// validate it (R-M1): a device reporting an invalid or non-v2 map is an
/// error, not a value.
pub fn parse_map(data: &str) -> Result<PinMap> {
    let f = Fields::parse(
        "map",
        data,
        &[
            "v", "flags", "dir", "pu", "pd", "def", "opol", "ipol", "edge",
        ],
    )?;
    let version: u8 = f.dec("v")?;
    if version != crate::types::PROTO_VERSION {
        return Err(SdkError::Parse(format!(
            "unsupported map version v={version} in map: {data}"
        )));
    }
    let map = PinMap {
        flags: f.u8_mask("flags")?,
        direction: f.mask("dir")?,
        pull_up: f.mask("pu")?,
        pull_down: f.mask("pd")?,
        out_default: f.mask("def")?,
        out_polarity: f.mask("opol")?,
        in_polarity: f.mask("ipol")?,
        edge: f.mask("edge")?,
    };
    map.validate()
        .map_err(|e| SdkError::Parse(format!("device reported an invalid map ({e}): {data}")))?;
    Ok(map)
}

/// Build the `map set` command for `map` (validated first).
pub fn map_set_command(map: &PinMap) -> Result<String> {
    Ok(format!("map set {}", map.to_set_args()?))
}

// --- read / write / state ---

/// Parse the `read` response `in=0x00000005`.
pub fn parse_read(data: &str) -> Result<u32> {
    Fields::parse("read", data, &["in"])?.mask("in")
}

/// Parse the `state` response `in=0x00000000 out=0x00000005`.
pub fn parse_state(data: &str) -> Result<IoState> {
    let f = Fields::parse("state", data, &["in", "out"])?;
    Ok(IoState {
        inputs: f.mask("in")?,
        outputs: f.mask("out")?,
    })
}

/// Build the `write <values> <mask>` command. Both words must stay within the
/// DIO pins (R-PIN2).
pub fn write_command(values: u32, mask: u32) -> Result<String> {
    check_dio_mask("write values", values)?;
    check_dio_mask("write mask", mask)?;
    Ok(format!("write {values:#x} {mask:#x}"))
}

// --- pattern ---

/// Build the `pattern add` command lines for `steps`.
///
/// Steps are packed greedily so every line stays within
/// [`MAX_LINE_BYTES`]; each line is applied atomically by the device (R-PT3).
/// Every step is validated first, so nothing is produced for a bad pattern.
pub fn pattern_add_commands(steps: &[PatternStep]) -> Result<Vec<String>> {
    if steps.is_empty() {
        return Err(SdkError::InvalidArgument(
            "pattern must have at least one step".into(),
        ));
    }
    const PREFIX: &str = "pattern add";
    let mut lines = Vec::new();
    let mut line = String::from(PREFIX);
    for step in steps {
        let text = step.to_text()?;
        // +1 for the separating space.
        if line.len() + 1 + text.len() > MAX_LINE_BYTES {
            lines.push(std::mem::replace(&mut line, String::from(PREFIX)));
        }
        line.push(' ');
        line.push_str(&text);
    }
    lines.push(line);
    Ok(lines)
}

/// Parse the `pattern add` response `total=<n>`: steps now in the buffer.
pub fn parse_pattern_total(data: &str) -> Result<u16> {
    Fields::parse("pattern add", data, &["total"])?.dec("total")
}

/// Build the `pattern run` command string. `once` plays a single pass and
/// ignores `repeat`; `loop` needs a `repeat` of 1-65535.
pub fn pattern_run_command(mode: PatternMode, repeat: u16) -> Result<String> {
    match mode {
        PatternMode::Once => Ok("pattern run once".to_string()),
        PatternMode::Loop if repeat == 0 => Err(SdkError::InvalidArgument(
            "pattern run loop needs a repeat of 1-65535".into(),
        )),
        PatternMode::Loop => Ok(format!("pattern run loop {repeat}")),
    }
}

/// Parse `state=running step=5 loops=3 total=40`.
pub fn parse_pattern_status(data: &str) -> Result<PatternStatus> {
    let f = Fields::parse("pattern status", data, &["state", "step", "loops", "total"])?;
    let state = match f.raw("state")? {
        "idle" => PatternState::Idle,
        "loaded" => PatternState::Loaded,
        "running" => PatternState::Running,
        "done" => PatternState::Done,
        other => {
            return Err(SdkError::Parse(format!("unknown pattern state: {other}")));
        }
    };
    Ok(PatternStatus {
        state,
        step: f.dec("step")?,
        loops: f.dec("loops")?,
        total: f.dec("total")?,
    })
}

// --- timestamp ---

/// Build the `ts arm` command string. The mask must stay within the DIO pins
/// (R-PIN2).
pub fn ts_arm_command(mask: u32, mode: EdgeMode) -> Result<String> {
    check_dio_mask("ts arm mask", mask)?;
    let mode = match mode {
        EdgeMode::Rising => "rising",
        EdgeMode::Falling => "falling",
        EdgeMode::Both => "both",
    };
    Ok(format!("ts arm {mask:#x} {mode}"))
}

/// Parse the `ts status` response `armed=1 pending=2 overflow=0`.
pub fn parse_ts_status(data: &str) -> Result<TsStatus> {
    let f = Fields::parse("ts status", data, &["armed", "pending", "overflow"])?;
    Ok(TsStatus {
        armed: f.flag("armed")?,
        pending: f.dec("pending")?,
        overflow: f.flag("overflow")?,
    })
}

/// Most events one `ts get` response can carry (line buffer limit).
pub const TS_GET_MAX: u16 = 85;

/// Build the `ts get <max>` command. `max` must be 1-[`TS_GET_MAX`]; the
/// device refuses anything else, so it is not sent.
pub fn ts_get_command(max: u16) -> Result<String> {
    if !(1..=TS_GET_MAX).contains(&max) {
        return Err(SdkError::InvalidArgument(format!(
            "ts get max {max} is out of range (1-{TS_GET_MAX})"
        )));
    }
    Ok(format!("ts get {max}"))
}

/// Parse the header of a `ts get` response, `count=3 overflow=0`, into the
/// number of event lines that follow and the ring-overflow flag.
pub fn parse_ts_get_header(data: &str) -> Result<(u32, bool)> {
    let f = Fields::parse("ts get", data, &["count", "overflow"])?;
    Ok((f.dec("count")?, f.flag("overflow")?))
}

/// Parse one `ts get` event line: `in=0x00000001 c=1000 p=7 s=1`
/// (surrounding whitespace, including the two leading spaces of a
/// continuation line, is ignored).
pub fn parse_ts_event_line(line: &str) -> Result<TimestampEvent> {
    let f = Fields::parse("ts event", line.trim(), &["in", "c", "p", "s"])?;
    let raw_phase: u8 = f.dec("p")?;
    if raw_phase > MAX_RAW_PHASE {
        return Err(f.invalid("p"));
    }
    Ok(TimestampEvent {
        inputs: f.mask("in")?,
        raw_count: f.dec("c")?,
        raw_phase,
        sync_active: f.flag("s")?,
    })
}

// --- sync ---

/// Parse the `sync count` response `clocks=1000000`.
pub fn parse_sync_count(data: &str) -> Result<u64> {
    Fields::parse("sync count", data, &["clocks"])?.dec("clocks")
}

// --- push events ---

/// Parse the payload of a push line (after `! `).
///
/// A recognized event with malformed fields is an error. Unknown event names
/// are preserved as [`PushEvent::Unknown`] so the caller can surface them.
pub fn parse_push_event(payload: &str) -> Result<PushEvent> {
    let trimmed = payload.trim();
    let (kind, rest) = trimmed.split_once(' ').unwrap_or((trimmed, ""));

    match kind {
        "INPUT" => {
            let f = Fields::parse("INPUT event", rest, &["in", "t"])?;
            Ok(PushEvent::InputChange {
                inputs: f.mask("in")?,
                t_us: f.dec("t")?,
            })
        }
        "PATTERN_DONE" => Ok(PushEvent::PatternDone {
            loops: Fields::parse("PATTERN_DONE event", rest, &["loops"])?.dec("loops")?,
        }),
        "PATTERN_TIMEOUT" => Ok(PushEvent::PatternTimeout {
            loops: Fields::parse("PATTERN_TIMEOUT event", rest, &["loops"])?.dec("loops")?,
        }),
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
            parse_response("OK fw=0.1.3 proto=2\r\n").unwrap(),
            Response::Ok("fw=0.1.3 proto=2".into())
        );
    }

    #[test]
    fn response_err() {
        assert_eq!(
            parse_response("ERR BAD_MAP\r\n").unwrap(),
            Response::Err("BAD_MAP".into())
        );
    }

    #[test]
    fn response_push() {
        assert_eq!(
            parse_response("! INPUT in=0x00000005 t=99\r\n").unwrap(),
            Response::Push("INPUT in=0x00000005 t=99".into())
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
        assert_eq!(parse_count_field("count=16").unwrap(), 16);
    }

    #[test]
    fn count_field_missing_or_bad() {
        assert_matches!(parse_count_field("n=2"), Err(SdkError::Parse(_)));
        assert_matches!(parse_count_field("count=abc"), Err(SdkError::Parse(_)));
        assert_matches!(parse_count_field("count=-1"), Err(SdkError::Parse(_)));
    }

    // --- Fields strictness (shared by every parser) ---

    #[test]
    fn fields_reject_unknown_duplicate_and_bare_tokens() {
        assert_matches!(parse_pong("pong=1 extra=2"), Err(SdkError::Parse(_)));
        assert_matches!(parse_pong("pong=1 pong=2"), Err(SdkError::Parse(_)));
        assert_matches!(parse_pong("pong"), Err(SdkError::Parse(_)));
        assert_matches!(parse_pong("1"), Err(SdkError::Parse(_)));
        assert_matches!(parse_pong(""), Err(SdkError::Parse(_)));
    }

    #[test]
    fn numbers_reject_signs_and_empty_digits() {
        assert_matches!(parse_pong("pong=+1"), Err(SdkError::Parse(_)));
        assert_matches!(parse_pong("pong=-1"), Err(SdkError::Parse(_)));
        assert_matches!(parse_pong("pong="), Err(SdkError::Parse(_)));
        assert_matches!(parse_read("in=0x"), Err(SdkError::Parse(_)));
        assert_matches!(parse_read("in=0x+5"), Err(SdkError::Parse(_)));
        assert_matches!(parse_read("in="), Err(SdkError::Parse(_)));
    }

    // --- version ---

    #[test]
    fn version_basic() {
        let v = parse_version("fw=0.1.3 proto=2").unwrap();
        assert_eq!(
            (v.major, v.minor, v.patch, v.protocol_version),
            (0, 1, 3, 2)
        );
    }

    #[test]
    fn version_multi_digit_and_key_order() {
        let v = parse_version("proto=2 fw=12.34.56").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (12, 34, 56));
    }

    #[test]
    fn version_reports_foreign_protocol_as_is() {
        assert_eq!(
            parse_version("fw=0.1.0 proto=1").unwrap().protocol_version,
            1
        );
    }

    #[test]
    fn version_malformed() {
        for bad in [
            "proto=2",
            "fw=0.1.3",
            "fw=0.1 proto=2",
            "fw=0.1.3.4 proto=2",
            "fw=X.Y.Z proto=2",
            "fw=v0.1.3 proto=2",
            "fw=0.1.256 proto=2",
            "fw=0.1.3 proto=two",
            "v0.1.0 proto=1",
            "",
        ] {
            assert_matches!(parse_version(bad), Err(SdkError::Parse(_)), "{bad}");
        }
    }

    // --- caps ---

    const CAPS: &str =
        "dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x00000003";

    #[test]
    fn caps_basic() {
        let c = parse_caps(CAPS).unwrap();
        assert_eq!((c.dio, c.out, c.r#in), (25, 2, 23));
        assert_eq!((c.ts_res_ns, c.tick_ns), (40, 200));
        assert_eq!((c.pattern_max, c.ring), (256, 256));
        assert_eq!(c.features, 3);
        assert!(c.has_sync() && c.has_reset());
    }

    #[test]
    fn caps_zero_features() {
        let c = parse_caps(
            "dio=25 out=0 in=25 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x00000000",
        )
        .unwrap();
        assert_eq!(c.out, 0);
        assert!(!c.has_sync() && !c.has_reset());
    }

    #[test]
    fn caps_v1_format_is_rejected() {
        // v1 reported `ts_res=40ns` and had no `tick_ns`.
        assert_matches!(
            parse_caps("dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x1"),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn caps_missing_or_malformed_field() {
        assert_matches!(parse_caps("dio=25 out=12 in=11"), Err(SdkError::Parse(_)));
        assert_matches!(
            parse_caps(&CAPS.replace("dio=25", "dio=banana")),
            Err(SdkError::Parse(_))
        );
        assert_matches!(
            parse_caps(&CAPS.replace("pattern=256", "pattern=65536")),
            Err(SdkError::Parse(_))
        );
        assert_matches!(
            parse_caps(&format!("{CAPS} proto=2")),
            Err(SdkError::Parse(_))
        );
    }

    // --- info / ping ---

    #[test]
    fn info_basic() {
        let (uid, devnum) = parse_info("uid=AABBCCDD11223344 devnum=42").unwrap();
        assert_eq!(uid, "AABBCCDD11223344");
        assert_eq!(devnum, Some(42));
    }

    #[test]
    fn info_unassigned_and_boundaries() {
        assert_eq!(
            parse_info("uid=0000000000000000 devnum=255").unwrap().1,
            None
        );
        assert_eq!(
            parse_info("uid=0000000000000000 devnum=0").unwrap().1,
            Some(0)
        );
        assert_eq!(
            parse_info("uid=0000000000000000 devnum=254").unwrap().1,
            Some(254)
        );
    }

    #[test]
    fn info_malformed() {
        for bad in [
            "devnum=1",
            "uid=AABBCCDD11223344",
            "uid=AABB devnum=1",
            "uid=ZZBBCCDD11223344 devnum=1",
            "uid=AABBCCDD11223344 devnum=256",
            "uid=AABBCCDD11223344 devnum=zzz",
        ] {
            assert_matches!(parse_info(bad), Err(SdkError::Parse(_)), "{bad}");
        }
    }

    #[test]
    fn pong_boundaries() {
        assert_eq!(parse_pong("pong=0").unwrap(), 0);
        assert_eq!(parse_pong("pong=4294967295").unwrap(), u32::MAX);
        assert_matches!(parse_pong("pong=4294967296"), Err(SdkError::Parse(_)));
    }

    // --- map ---

    const MAP: &str = "v=2 flags=0x00 dir=0x0000000f pu=0x000000f0 pd=0x0c7fff00 \
                       def=0x00000005 opol=0x00000008 ipol=0x00000100 edge=0x0c7ffff0";

    #[test]
    fn map_get_round_trips_through_set_command() {
        let map = parse_map(MAP).unwrap();
        assert_eq!(map_set_command(&map).unwrap(), format!("map set {MAP}"));
    }

    #[test]
    fn map_default_response() {
        let map = parse_map(
            "v=2 flags=0x00 dir=0x00000000 pu=0x00000000 pd=0x0c7fffff def=0x00000000 \
             opol=0x00000000 ipol=0x00000000 edge=0x0c7fffff",
        )
        .unwrap();
        assert_eq!(map, PinMap::default());
    }

    #[test]
    fn map_rejects_wrong_version() {
        assert_matches!(
            parse_map(&MAP.replace("v=2", "v=1")),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn map_rejects_v1_format() {
        assert_matches!(
            parse_map("v=1 out=0:12 in=12:11 pull=up flags=0x01"),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn map_rejects_invalid_device_map() {
        // dir bit 23 is not a DIO pin.
        assert_matches!(
            parse_map(&MAP.replace("dir=0x0000000f", "dir=0x0080000f")),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn map_missing_unknown_or_bad_field() {
        assert_matches!(parse_map("v=2 flags=0x00"), Err(SdkError::Parse(_)));
        assert_matches!(
            parse_map(&format!("{MAP} extra=0x0")),
            Err(SdkError::Parse(_))
        );
        assert_matches!(
            parse_map(&MAP.replace("flags=0x00", "flags=0x100")),
            Err(SdkError::Parse(_))
        );
        assert_matches!(
            parse_map(&MAP.replace("pu=0x000000f0", "pu=0xzz")),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn map_set_command_refuses_invalid_map() {
        let bad = PinMap {
            flags: 1,
            ..PinMap::default()
        };
        assert_matches!(map_set_command(&bad), Err(SdkError::InvalidArgument(_)));
    }

    // --- read / write / state ---

    #[test]
    fn read_basic() {
        assert_eq!(parse_read("in=0x00000005").unwrap(), 5);
        assert_eq!(parse_read("in=0x0c7fffff").unwrap(), 0x0c7f_ffff);
        assert_eq!(parse_read("in=5").unwrap(), 5);
    }

    #[test]
    fn read_malformed() {
        assert_matches!(parse_read("0x5"), Err(SdkError::Parse(_)));
        assert_matches!(parse_read("five"), Err(SdkError::Parse(_)));
        assert_matches!(parse_read(""), Err(SdkError::Parse(_)));
        assert_matches!(parse_read("in=0x1ffffffff"), Err(SdkError::Parse(_)));
    }

    #[test]
    fn state_basic() {
        let s = parse_state("in=0x00000030 out=0x00000005").unwrap();
        assert_eq!((s.inputs, s.outputs), (0x30, 5));
    }

    #[test]
    fn state_missing_or_legacy_field() {
        assert_matches!(parse_state("in=0x05"), Err(SdkError::Parse(_)));
        assert_matches!(
            parse_state("in=0x05 out=0x0A flags=0x00"),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn write_command_formats_and_checks_masks() {
        assert_eq!(write_command(0x5, 0xf).unwrap(), "write 0x5 0xf");
        assert_eq!(
            write_command(0x0c00_0000, 0x0c00_0000).unwrap(),
            "write 0xc000000 0xc000000"
        );
        assert_matches!(write_command(1 << 23, 1), Err(SdkError::InvalidArgument(_)));
        assert_matches!(write_command(1, 1 << 28), Err(SdkError::InvalidArgument(_)));
    }

    // --- pattern ---

    fn step(out_bits: u32, hold_ticks: u32) -> PatternStep {
        PatternStep {
            out_bits,
            hold_ticks,
        }
    }

    #[test]
    fn pattern_add_single_line() {
        let lines = pattern_add_commands(&[step(1, 5), step(0, 10)]).unwrap();
        assert_eq!(lines, vec!["pattern add 0x1:5 0x0:10"]);
    }

    #[test]
    fn pattern_add_splits_at_the_line_limit_without_losing_steps() {
        let steps: Vec<PatternStep> = (0..256).map(|_| step(0, 1)).collect();
        let lines = pattern_add_commands(&steps).unwrap();
        assert!(lines.len() > 1);
        let mut total = 0;
        for line in &lines {
            assert!(line.len() <= MAX_LINE_BYTES, "{}", line.len());
            assert!(line.starts_with("pattern add 0x0:1"));
            total += line.split_whitespace().count() - 2;
        }
        assert_eq!(total, 256);
        // Greedy packing: all but the last line are full to within one step.
        for line in &lines[..lines.len() - 1] {
            assert!(line.len() + " 0x0:1".len() > MAX_LINE_BYTES);
        }
    }

    #[test]
    fn pattern_add_packs_to_the_byte_limit() {
        // The longest single step still fits on one line.
        let lines = pattern_add_commands(&[step(0x0c7f_ffff, u32::MAX)]).unwrap();
        assert_eq!(lines, vec!["pattern add 0xc7fffff:4294967295"]);
        let steps: Vec<PatternStep> = (0..41).map(|_| step(0, 1)).collect();
        // 11 + 41 * 6 = 257 > 256: the 41st step starts a new line.
        let lines = pattern_add_commands(&steps).unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), 11 + 40 * 6);
        assert_eq!(lines[1], "pattern add 0x0:1");
    }

    #[test]
    fn pattern_add_rejects_empty_and_invalid_steps() {
        assert_matches!(pattern_add_commands(&[]), Err(SdkError::InvalidArgument(_)));
        assert_matches!(
            pattern_add_commands(&[step(1, 1), step(1, 0)]),
            Err(SdkError::InvalidArgument(_))
        );
        assert_matches!(
            pattern_add_commands(&[step(1 << 25, 1)]),
            Err(SdkError::InvalidArgument(_))
        );
    }

    #[test]
    fn pattern_total() {
        assert_eq!(parse_pattern_total("total=256").unwrap(), 256);
        assert_matches!(parse_pattern_total("accepted=4"), Err(SdkError::Parse(_)));
        assert_matches!(parse_pattern_total("total=x"), Err(SdkError::Parse(_)));
        assert_matches!(parse_pattern_total("total=65536"), Err(SdkError::Parse(_)));
    }

    #[test]
    fn pattern_run_commands() {
        // `once` plays one pass; the repeat is ignored and not sent.
        assert_eq!(
            pattern_run_command(PatternMode::Once, 1).unwrap(),
            "pattern run once"
        );
        assert_eq!(
            pattern_run_command(PatternMode::Once, 0).unwrap(),
            "pattern run once"
        );
        assert_eq!(
            pattern_run_command(PatternMode::Loop, 10).unwrap(),
            "pattern run loop 10"
        );
        assert_eq!(
            pattern_run_command(PatternMode::Loop, 1).unwrap(),
            "pattern run loop 1"
        );
        assert_eq!(
            pattern_run_command(PatternMode::Loop, u16::MAX).unwrap(),
            "pattern run loop 65535"
        );
        // `loop` needs 1-65535; there is no infinite mode.
        assert_matches!(
            pattern_run_command(PatternMode::Loop, 0),
            Err(SdkError::InvalidArgument(_))
        );
    }

    #[test]
    fn ts_get_commands() {
        assert_eq!(ts_get_command(1).unwrap(), "ts get 1");
        assert_eq!(ts_get_command(85).unwrap(), "ts get 85");
        for bad in [0, 86, 256, u16::MAX] {
            assert_matches!(
                ts_get_command(bad),
                Err(SdkError::InvalidArgument(_)),
                "{bad}"
            );
        }
    }

    #[test]
    fn pattern_status_basic() {
        let s = parse_pattern_status("state=running step=5 loops=3 total=40").unwrap();
        assert_eq!(s.state, PatternState::Running);
        assert_eq!((s.step, s.loops, s.total), (5, 3, 40));
    }

    #[test]
    fn pattern_status_all_states() {
        for (text, state) in [
            ("idle", PatternState::Idle),
            ("loaded", PatternState::Loaded),
            ("running", PatternState::Running),
            ("done", PatternState::Done),
        ] {
            let s = parse_pattern_status(&format!("state={text} step=0 loops=0 total=0")).unwrap();
            assert_eq!(s.state, state);
        }
    }

    #[test]
    fn pattern_status_malformed() {
        assert_matches!(
            parse_pattern_status("state=paused step=0 loops=0 total=0"),
            Err(SdkError::Parse(_))
        );
        assert_matches!(parse_pattern_status("state=idle"), Err(SdkError::Parse(_)));
        // v1 had no total=.
        assert_matches!(
            parse_pattern_status("state=idle step=0 loops=0"),
            Err(SdkError::Parse(_))
        );
    }

    // --- timestamp ---

    #[test]
    fn ts_arm_commands() {
        assert_eq!(
            ts_arm_command(0x07FF, EdgeMode::Rising).unwrap(),
            "ts arm 0x7ff rising"
        );
        assert_eq!(
            ts_arm_command(1, EdgeMode::Falling).unwrap(),
            "ts arm 0x1 falling"
        );
        assert_eq!(
            ts_arm_command(0x0c00_0000, EdgeMode::Both).unwrap(),
            "ts arm 0xc000000 both"
        );
    }

    #[test]
    fn ts_arm_rejects_non_dio_bits() {
        for bit in [23u32, 24, 25, 28, 31] {
            assert_matches!(
                ts_arm_command(1 << bit, EdgeMode::Both),
                Err(SdkError::InvalidArgument(_)),
                "bit {bit}"
            );
        }
    }

    #[test]
    fn ts_status_basic() {
        let s = parse_ts_status("armed=1 pending=256 overflow=1").unwrap();
        assert_eq!((s.armed, s.pending, s.overflow), (true, 256, true));
        let s = parse_ts_status("armed=0 pending=0 overflow=0").unwrap();
        assert_eq!((s.armed, s.pending, s.overflow), (false, 0, false));
    }

    #[test]
    fn ts_status_malformed() {
        assert_matches!(
            parse_ts_status("armed=2 pending=0 overflow=0"),
            Err(SdkError::Parse(_))
        );
        assert_matches!(
            parse_ts_status("armed=1 pending=0"),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn ts_get_header() {
        assert_eq!(
            parse_ts_get_header("count=3 overflow=0").unwrap(),
            (3, false)
        );
        assert_eq!(
            parse_ts_get_header("overflow=1 count=85").unwrap(),
            (85, true)
        );
        assert_eq!(
            parse_ts_get_header("count=0 overflow=0").unwrap(),
            (0, false)
        );
    }

    #[test]
    fn ts_get_header_malformed() {
        // overflow= is mandatory in v2; there is no fallback for old FW.
        assert_matches!(parse_ts_get_header("count=3"), Err(SdkError::Parse(_)));
        assert_matches!(
            parse_ts_get_header("count=1 overflow=2"),
            Err(SdkError::Parse(_))
        );
        assert_matches!(
            parse_ts_get_header("count=1 overflow=yes"),
            Err(SdkError::Parse(_))
        );
        assert_matches!(parse_ts_get_header("overflow=0"), Err(SdkError::Parse(_)));
    }

    #[test]
    fn ts_event_basic() {
        let ev = parse_ts_event_line("  in=0x00000005 c=1000 p=7 s=1").unwrap();
        assert_eq!(ev.inputs, 5);
        assert_eq!(ev.raw_count, 1000);
        assert_eq!(ev.raw_phase, 7);
        assert!(ev.sync_active);
        assert_eq!(ev.ns(40), 1_000_280);
    }

    #[test]
    fn ts_event_free_running() {
        let ev = parse_ts_event_line("in=0x00000001 c=500 p=0 s=0").unwrap();
        assert!(!ev.sync_active);
        assert_eq!(ev.ns(40), 500_000);
    }

    #[test]
    fn ts_event_phase_limits() {
        assert_eq!(
            parse_ts_event_line("in=0x1 c=0 p=24 s=1").unwrap().ns(40),
            960
        );
        assert_matches!(
            parse_ts_event_line("in=0x1 c=0 p=25 s=1"),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn ts_event_old_formats_are_rejected() {
        assert_matches!(
            parse_ts_event_line("0x00000005 c=1000 p=7 s=1"),
            Err(SdkError::Parse(_))
        );
        assert_matches!(
            parse_ts_event_line("0x00000005 t=1234567890"),
            Err(SdkError::Parse(_))
        );
    }

    #[test]
    fn ts_event_missing_or_bad_fields() {
        for bad in [
            "in=0x05 c=1000 p=7",
            "c=1000 p=7 s=1",
            "in=0x05 c=1000 p=7 s=2",
            "in=0x05 c=4294967296 p=7 s=1",
            "in=0x05 c=1 p=7 s=1 extra=1",
            "",
        ] {
            assert_matches!(parse_ts_event_line(bad), Err(SdkError::Parse(_)), "{bad}");
        }
    }

    // --- sync ---

    #[test]
    fn sync_count_basic() {
        assert_eq!(parse_sync_count("clocks=1000000").unwrap(), 1_000_000);
        assert_eq!(
            parse_sync_count("clocks=4294967297").unwrap(),
            4_294_967_297
        );
    }

    #[test]
    fn sync_count_rejects_count_key() {
        // `count=` is reserved for counted multi-line responses (R-T2).
        assert_matches!(parse_sync_count("count=1000000"), Err(SdkError::Parse(_)));
        assert_matches!(parse_sync_count("1000000"), Err(SdkError::Parse(_)));
    }

    // --- push events ---

    #[test]
    fn push_input_change() {
        let ev = parse_push_event("INPUT in=0x00000005 t=1234567890").unwrap();
        assert_matches!(
            ev,
            PushEvent::InputChange {
                inputs: 5,
                t_us: 1234567890
            }
        );
    }

    #[test]
    fn push_pattern_done() {
        let ev = parse_push_event("PATTERN_DONE loops=10").unwrap();
        assert_matches!(ev, PushEvent::PatternDone { loops: 10 });
    }

    #[test]
    fn push_pattern_timeout() {
        let ev = parse_push_event("PATTERN_TIMEOUT loops=42").unwrap();
        assert_matches!(ev, PushEvent::PatternTimeout { loops: 42 });
        let ev = parse_push_event("PATTERN_TIMEOUT loops=0").unwrap();
        assert_matches!(ev, PushEvent::PatternTimeout { loops: 0 });
    }

    #[test]
    fn push_malformed_known_events() {
        for bad in [
            "PATTERN_TIMEOUT",
            "PATTERN_TIMEOUT loops=abc",
            "PATTERN_DONE loops=abc",
            "PATTERN_DONE loops=65536",
            "INPUT t=99",
            "INPUT in=0x05",
            "INPUT 0x05 t=99",
            "INPUT in=garbage t=1",
        ] {
            assert_matches!(parse_push_event(bad), Err(SdkError::Parse(_)), "{bad}");
        }
    }

    #[test]
    fn push_removed_and_unknown_events_are_not_typed() {
        // SYNC_DONE no longer exists; it is observable only as Unknown.
        let ev = parse_push_event("SYNC_DONE status=ready devnum=1 ts=12345").unwrap();
        assert_matches!(ev, PushEvent::Unknown { ref raw } if raw.starts_with("SYNC_DONE"));
        let ev = parse_push_event("FUTURE_EVENT data=1").unwrap();
        assert_matches!(ev, PushEvent::Unknown { ref raw } if raw == "FUTURE_EVENT data=1");
    }
}
