//! Replays every response line of the v2 golden transcripts
//! (`protocol/golden/*.txt`) through the SDK's typed parsers.
//!
//! The transcripts are the single source of truth for the wire format
//! (REF-V2 R-P4), so a parser that rejects any firmware-generated line, or a
//! typed value that does not re-encode to the same text, fails here.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use pochi_sdk::protocol::{self, Response};
use pochi_sdk::{PatternState, PinMap, PushEvent, SdkError};

const GOLDEN_FILES: [&str; 11] = [
    "version-info",
    "map",
    "io",
    "pattern",
    "timestamp",
    "sync",
    "reset",
    "errors",
    "boundary",
    "events",
    "safety",
];

/// The feature bits defined by the protocol (`caps feat=`): bits 0..=7.
const KNOWN_FEATURE_BITS: u32 = 0xff;

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/golden")
}

/// Decode the text request carried by a `~ send_hex` directive, if it is one
/// (printable text ending in CR/LF). Raw binary bytes yield `None`.
fn send_hex_request(args: &str) -> Option<String> {
    let bytes: Vec<u8> = args
        .split_whitespace()
        .map(|h| u8::from_str_radix(h, 16).expect("hex byte"))
        .collect();
    let text = String::from_utf8(bytes).ok()?;
    let trimmed = text.trim_matches(['\r', '\n']);
    let first = trimmed.chars().next()?;
    first.is_ascii_alphabetic().then(|| trimmed.to_string())
}

/// Normalized request form: lower-cased command words, arguments dropped.
fn form_of(request: &str) -> String {
    let words: Vec<String> = request
        .split_whitespace()
        .map(|w| w.to_ascii_lowercase())
        .collect();
    match words.first().map(String::as_str) {
        Some("map" | "pattern" | "ts" | "sync" | "subscribe") => {
            words[..words.len().min(2)].join(" ")
        }
        Some(w) => w.to_string(),
        None => String::new(),
    }
}

/// Parse one `OK` response of the given form; `lines` are the continuation
/// lines (wire lines, with their two leading spaces).
fn check_ok(ctx: &str, form: &str, data: &str, lines: &[String], seen: &mut BTreeSet<String>) {
    match form {
        "version" => {
            let v = protocol::parse_version(data).unwrap();
            assert_eq!(v.protocol_version, 2, "{data}");
        }
        "caps" => {
            let c = protocol::parse_caps(data).unwrap();
            assert_eq!(c.dio, 25);
            assert_eq!(c.ts_res_ns, 40);
            assert_eq!(c.tick_ns, 200);
            assert_eq!(c.pattern_max, 256);
            assert_eq!(c.ring, 256);
            // The transcripts carry the feature mask of the firmware they
            // describe; pin neither its value nor its history, only that it is
            // a mask over the defined bits (the eight `feat` bits) that
            // announces what this SDK relies on.
            assert_eq!(c.features & !KNOWN_FEATURE_BITS, 0, "undefined feat bits");
            assert!(c.has_sync() && c.has_reset());
            assert!(u32::from(c.out) + u32::from(c.r#in) == u32::from(c.dio));
        }
        "info" => {
            let (uid, _) = protocol::parse_info(data).unwrap();
            assert_eq!(uid, "0000000000000000");
        }
        "ping" => {
            protocol::parse_pong(data).unwrap();
        }
        "read" => {
            protocol::parse_read(data).unwrap();
        }
        "state" => {
            protocol::parse_state(data).unwrap();
        }
        "map get" => {
            let map = PinMap::parse_get(data).unwrap();
            // R-M3: the payload pastes back into `map set` unchanged.
            assert_eq!(map.to_set_args().unwrap(), data);
        }
        "pattern add" => {
            protocol::parse_pattern_total(data).unwrap();
        }
        "pattern status" => {
            let s = protocol::parse_pattern_status(data).unwrap();
            assert!(s.total <= 256);
            if s.state == PatternState::Idle {
                assert_eq!(s.total, 0, "{data}");
            }
        }
        "ts get" => {
            let (count, _overflow) = protocol::parse_ts_get_header(data).unwrap();
            assert_eq!(lines.len() as u32, count, "{data}");
            for line in lines {
                let ev = protocol::parse_ts_event_line(line).unwrap();
                assert!(ev.raw_phase <= 24);
            }
        }
        "ts status" => {
            protocol::parse_ts_status(data).unwrap();
        }
        "sync count" => {
            protocol::parse_sync_count(data).unwrap();
        }
        "help" => {
            let count = protocol::parse_count_field(data).unwrap();
            assert_eq!(lines.len() as u64, count);
        }
        "devnum" | "map set" | "map save" | "map default" | "write" | "pattern run"
        | "pattern stop" | "pattern reset" | "ts arm" | "ts disarm" | "subscribe on"
        | "subscribe off" | "sync arm" | "sync master" | "sync start" | "sync stop"
        | "sync disarm" | "reset" | "bootsel" => {
            assert_eq!(data, "", "bare OK expected for `{form}`");
        }
        other => panic!("{ctx}: golden response for unhandled request form `{other}`: OK {data}"),
    }
    seen.insert(form.to_string());
}

#[test]
fn every_golden_response_parses() {
    let mut seen_forms = BTreeSet::new();
    let mut seen_events = BTreeSet::new();
    let mut seen_errors = BTreeSet::new();
    let mut ok_lines = 0usize;

    for name in GOLDEN_FILES {
        let path = golden_dir().join(format!("{name}.txt"));
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        let all: Vec<&str> = text.lines().collect();

        let mut request: Option<String> = None;
        // Name of the case being replayed (`# --- <name> ---`), so a failure
        // names the case and not only the line.
        let mut case = String::new();
        let mut i = 0usize;
        while i < all.len() {
            let line = all[i];
            i += 1;
            if let Some(heading) = line
                .strip_prefix("# --- ")
                .and_then(|h| h.strip_suffix(" ---"))
            {
                case = heading.to_string();
            }
            let ctx = format!("{name}.txt:{i} [{case}]: {line}");
            if let Some(req) = line.strip_prefix("> ") {
                request = Some(req.to_string());
            } else if let Some(args) = line.strip_prefix("~ send_hex ") {
                request = send_hex_request(args);
            } else if let Some(rest) = line.strip_prefix("< ! ") {
                match protocol::parse_push_event(rest).unwrap_or_else(|e| panic!("{ctx}: {e}")) {
                    PushEvent::InputChange { .. } => seen_events.insert("INPUT"),
                    PushEvent::PatternDone { .. } => seen_events.insert("PATTERN_DONE"),
                    PushEvent::PatternTimeout { .. } => seen_events.insert("PATTERN_TIMEOUT"),
                    other => panic!("{ctx}: unexpected event {other:?}"),
                };
            } else if let Some(code) = line.strip_prefix("< ERR ") {
                assert_matches_err(&ctx, code);
                seen_errors.insert(code.to_string());
                match protocol::parse_response(line.strip_prefix("< ").unwrap()).unwrap() {
                    Response::Err(c) => assert_eq!(c, code),
                    other => panic!("{ctx}: {other:?}"),
                }
                request = None;
            } else if let Some(rest) = line.strip_prefix("< OK") {
                let data = rest.strip_prefix(' ').unwrap_or(rest);
                let mut cont = Vec::new();
                while i < all.len() && all[i].starts_with("<   ") {
                    cont.push(all[i][2..].to_string());
                    i += 1;
                }
                let form = form_of(
                    request
                        .as_deref()
                        .unwrap_or_else(|| panic!("{ctx}: no request")),
                );
                check_ok(&ctx, &form, data, &cont, &mut seen_forms);
                match protocol::parse_response(line.strip_prefix("< ").unwrap()).unwrap() {
                    Response::Ok(d) => assert_eq!(d, data),
                    other => panic!("{ctx}: {other:?}"),
                }
                ok_lines += 1;
                request = None;
            }
        }
    }

    assert!(ok_lines > 500, "golden replay looks truncated: {ok_lines}");
    for form in [
        "version",
        "caps",
        "info",
        "ping",
        "read",
        "state",
        "map get",
        "map set",
        "pattern add",
        "pattern status",
        "ts get",
        "ts status",
        "sync count",
        "help",
        "devnum",
        "write",
    ] {
        assert!(seen_forms.contains(form), "golden never exercised `{form}`");
    }
    assert_eq!(
        seen_events,
        BTreeSet::from(["INPUT", "PATTERN_DONE", "PATTERN_TIMEOUT"])
    );
    for code in [
        "BAD_PARAM",
        "BAD_MAP",
        "BUSY",
        "FLASH",
        "TOO_LONG",
        "NOT_ARMED",
    ] {
        assert!(seen_errors.contains(code), "golden never exercised {code}");
    }
}

fn assert_matches_err(ctx: &str, code: &str) {
    let err = SdkError::from_error_code(code);
    assert!(
        !matches!(err, SdkError::UnknownDevice(_)),
        "{ctx}: error name {code} has no typed SdkError"
    );
}
