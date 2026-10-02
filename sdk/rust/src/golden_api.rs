//! Replays the A0 golden transcripts (`protocol/golden/*.txt`) through the
//! typed [`Connection`] methods.
//!
//! For every `>` request that a typed method can express, the test calls that
//! method against a fake device that answers with the transcript's recorded
//! response, and checks that
//!
//! * the method put the same command on the wire (modulo spelling: case,
//!   number base, argument order of `map set`), and
//! * the typed result agrees with the response (`OK` is `Ok`, `ERR NAME` is
//!   the matching [`SdkError`]).
//!
//! A request the SDK refuses locally (`InvalidArgument`, nothing sent) is
//! accepted only where the transcript records an `ERR` answer. Requests no
//! typed method can express (malformed text, `subscribe`, which the SDK owns)
//! are skipped; the test fails if a command method is never exercised.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::connection::Connection;
use crate::error::SdkError;
use crate::testutil::{pong_for, FakeDevice};
use crate::transport::Transport;
use crate::types::{EdgeMode, PatternStep, PinMap};

const GOLDEN_FILES: [&str; 10] = [
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
];

/// One request and the response the device recorded for it.
struct Exchange {
    at: String,
    request: String,
    response: Vec<String>,
}

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/golden")
}

/// Pair every `>` request with the response that follows it. Events and
/// directives are not part of a response and are ignored; a request without
/// a response (silence cases) is dropped.
fn exchanges() -> Vec<Exchange> {
    let mut out = Vec::new();
    for name in GOLDEN_FILES {
        let path = golden_dir().join(format!("{name}.txt"));
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        let lines: Vec<&str> = text.lines().collect();
        let mut i = 0;
        while i < lines.len() {
            let Some(request) = lines[i].strip_prefix("> ") else {
                i += 1;
                continue;
            };
            let at = format!("{name}.txt:{}", i + 1);
            i += 1;
            // The response is the header on the next line plus, for a
            // counted response, its continuation lines (`<` + three
            // spaces). Anything else after it is an event or a directive.
            let mut response = Vec::new();
            if lines
                .get(i)
                .is_some_and(|l| l.starts_with("< OK") || l.starts_with("< ERR "))
            {
                response.push(lines[i][2..].to_string());
                i += 1;
                while i < lines.len() && lines[i].starts_with("<   ") {
                    response.push(lines[i][2..].to_string());
                    i += 1;
                }
            }
            if !response.is_empty() {
                out.push(Exchange {
                    at,
                    request: request.to_string(),
                    response,
                });
            }
        }
    }
    out
}

/// A connection to a fake device that answers each exchange with the
/// scripted response.
struct Rig {
    conn: Option<Connection>,
    dev: FakeDevice,
    script: Arc<Mutex<Option<Vec<String>>>>,
}

impl Rig {
    fn new() -> Self {
        let script: Arc<Mutex<Option<Vec<String>>>> = Arc::new(Mutex::new(None));
        let (reader, writer, dev) = FakeDevice::spawn({
            let script = Arc::clone(&script);
            move |cmd| {
                if let Some(reply) = script.lock().expect("script").clone() {
                    return reply;
                }
                if cmd == "version" {
                    return vec!["OK fw=0.1.3 proto=2".to_string()];
                }
                pong_for(cmd).unwrap_or_else(|| vec!["ERR UNKNOWN_CMD".to_string()])
            }
        });
        let mut transport = Transport::from_io(Box::new(reader), Box::new(writer));
        transport.set_timeout(Duration::from_millis(500));
        let conn = Connection::establish(transport, "golden".into()).expect("open");
        Self {
            conn: Some(conn),
            dev,
            script,
        }
    }
}

// ---------------------------------------------------------------- parsing

fn num(token: &str) -> Option<u64> {
    match token
        .strip_prefix("0x")
        .or_else(|| token.strip_prefix("0X"))
    {
        Some(hex) => u64::from_str_radix(hex, 16).ok(),
        None => token.parse().ok(),
    }
}

fn num32(token: &str) -> Option<u32> {
    num(token).and_then(|v| u32::try_from(v).ok())
}

/// Spelling-independent form of a command line: lower case, numbers in
/// decimal, `map set` fields sorted without the optional `v=2`, and
/// the ignored repeat of `pattern run once` dropped.
fn canon(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let mut words: Vec<String> = lower
        .split_whitespace()
        .map(|word| {
            word.split(['=', ':'])
                .map(|piece| num(piece).map_or_else(|| piece.to_string(), |n| n.to_string()))
                .collect::<Vec<_>>()
                .join(if word.contains('=') { "=" } else { ":" })
        })
        .collect();
    if words.starts_with(&["pattern".into(), "run".into(), "once".into()]) {
        words.truncate(3);
    }
    if words.starts_with(&["map".into(), "set".into()]) {
        let mut fields: Vec<String> = words.drain(2..).filter(|w| w != "v=2").collect();
        fields.sort();
        words.extend(fields);
    }
    words.join(" ")
}

fn pin_map(fields: &[&str]) -> Option<PinMap> {
    let mut map = PinMap::default();
    let mut seen = BTreeSet::new();
    for field in fields {
        let (key, value) = field.split_once('=')?;
        if key == "v" {
            if value != "2" {
                return None;
            }
            continue;
        }
        let v = num32(value)?;
        match key {
            "flags" => map.flags = u8::try_from(v).ok()?,
            "dir" => map.direction = v,
            "pu" => map.pull_up = v,
            "pd" => map.pull_down = v,
            "def" => map.out_default = v,
            "opol" => map.out_polarity = v,
            "ipol" => map.in_polarity = v,
            "edge" => map.edge = v,
            _ => return None,
        }
        // A repeated key cannot be expressed by a typed map.
        if !seen.insert(key) {
            return None;
        }
    }
    (seen.len() == 8).then_some(map)
}

fn steps(args: &[&str]) -> Option<Vec<PatternStep>> {
    args.iter()
        .map(|a| {
            let (out, hold) = a.split_once(':')?;
            Some(PatternStep {
                out_bits: num32(out)?,
                hold_ticks: num32(hold)?,
            })
        })
        .collect()
}

// --------------------------------------------------------------- dispatch

/// Result of calling a typed method for one request.
type Call = Result<(), SdkError>;

/// Call the typed method for `request` (already lower-cased words), or
/// `None` when no method expresses it. Returns the name of the method
/// as well.
fn dispatch(rig: &mut Rig, request: &str) -> Option<(&'static str, Call)> {
    let lower = request.to_ascii_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    let conn = rig.conn.as_mut().expect("connection");
    let r = match words.as_slice() {
        ["version"] => ("version", conn.version().map(drop)),
        ["caps"] => ("caps", conn.caps().map(drop)),
        ["info"] => ("info", conn.info().map(drop)),
        ["ping", n] => ("ping", conn.ping(num32(n)?).map(drop)),
        ["devnum", n] => (
            "set_device_number",
            conn.set_device_number(u8::try_from(num(n)?).ok()?),
        ),
        ["read"] => ("read", conn.read().map(drop)),
        ["state"] => ("state", conn.state().map(drop)),
        ["write", v, m] => ("write", conn.write(num32(v)?, num32(m)?)),
        ["map", "get"] => ("map_get", conn.map_get().map(drop)),
        ["map", "save"] => ("map_save", conn.map_save()),
        ["map", "default"] => ("map_default", conn.map_default()),
        ["map", "set", fields @ ..] => ("map_set", conn.map_set(&pin_map(fields)?)),
        ["pattern", "add", args @ ..] if !args.is_empty() => {
            ("pattern_add", conn.pattern_add(&steps(args)?).map(drop))
        }
        ["pattern", "run", "once", ..] => ("pattern_run_once", conn.pattern_run_once()),
        ["pattern", "run", "loop", n] => (
            "pattern_run_loop",
            conn.pattern_run_loop(u16::try_from(num(n)?).ok()?),
        ),
        ["pattern", "stop"] => ("pattern_stop", conn.pattern_stop()),
        ["pattern", "reset"] => ("pattern_reset", conn.pattern_reset()),
        ["pattern", "status"] => ("pattern_status", conn.pattern_status().map(drop)),
        ["ts", "arm", mask, mode] => {
            let mode = match *mode {
                "rising" => EdgeMode::Rising,
                "falling" => EdgeMode::Falling,
                "both" => EdgeMode::Both,
                _ => return None,
            };
            ("ts_arm", conn.ts_arm(num32(mask)?, mode))
        }
        ["ts", "get", n] => (
            "ts_get",
            conn.ts_get(u16::try_from(num(n)?).ok()?).map(drop),
        ),
        ["ts", "status"] => ("ts_status", conn.ts_status().map(drop)),
        ["ts", "disarm"] => ("ts_disarm", conn.ts_disarm()),
        ["sync", "arm"] => ("sync_arm", conn.sync_arm()),
        ["sync", "master"] => ("sync_master", conn.sync_master()),
        ["sync", "start"] => ("sync_start", conn.sync_start()),
        ["sync", "stop"] => ("sync_stop", conn.sync_stop()),
        ["sync", "disarm"] => ("sync_disarm", conn.sync_disarm()),
        ["sync", "count"] => ("sync_count", conn.sync_count().map(drop)),
        ["help"] => ("help", conn.help().map(drop)),
        ["reset"] => {
            let conn = rig.conn.take().expect("connection");
            ("system_reset", conn.system_reset())
        }
        ["bootsel"] => {
            let conn = rig.conn.take().expect("connection");
            ("bootsel_reset", conn.bootsel_reset())
        }
        _ => return None,
    };
    Some(r)
}

#[test]
fn typed_methods_agree_with_every_golden_exchange() {
    let exchanges = exchanges();
    assert!(exchanges.len() > 700, "golden set looks truncated");

    let mut rig = Rig::new();
    let mut exercised = BTreeSet::new();
    let mut local_rejections = 0usize;

    for ex in &exchanges {
        if rig.conn.is_none() {
            rig = Rig::new();
        }
        let ctx = format!("{} `{}`", ex.at, ex.request);
        let sent_before = rig.dev.commands().len();
        *rig.script.lock().expect("script") = Some(ex.response.clone());
        let Some((method, call)) = dispatch(&mut rig, &ex.request) else {
            *rig.script.lock().expect("script") = None;
            continue;
        };
        *rig.script.lock().expect("script") = None;
        exercised.insert(method);

        let sent: Vec<String> = rig.dev.commands()[sent_before..].to_vec();
        let header = &ex.response[0];
        match (&call, header.strip_prefix("ERR ")) {
            (Err(SdkError::InvalidArgument(_)), Some(_)) => {
                // Refused on the host before sending; the device would have
                // answered ERR as well (R-PIN2, R-M1 and friends).
                assert!(sent.is_empty(), "{ctx}: refused locally but sent {sent:?}");
                local_rejections += 1;
                continue;
            }
            (Ok(()), None) => {}
            (Err(e), Some(name)) => assert_eq!(
                e.to_string(),
                SdkError::from_error_code(name).to_string(),
                "{ctx}"
            ),
            (Ok(()), Some(name)) => panic!("{ctx}: device answered ERR {name}, method succeeded"),
            (Err(SdkError::InvalidArgument(_)), None) if method == "write" => {
                // The device ignores `write` value bits outside the mask,
                // including non-DIO bits; the SDK is stricter (R-PIN2) and
                // refuses a value word outside the DIO pins.
                assert!(sent.is_empty(), "{ctx}: refused locally but sent {sent:?}");
                continue;
            }
            (Err(e), None) => panic!("{ctx}: device answered `{header}`, method failed: {e}"),
        }

        if method == "pattern_add" {
            // Long requests may need more lines in the SDK's canonical
            // spelling; compare the step lists.
            let wire: Vec<String> = sent
                .iter()
                .flat_map(|l| {
                    l.strip_prefix("pattern add ")
                        .expect("pattern add")
                        .split(' ')
                })
                .map(str::to_string)
                .collect();
            let golden: Vec<String> = canon(&ex.request)
                .strip_prefix("pattern add ")
                .expect("pattern add")
                .split(' ')
                .map(str::to_string)
                .collect();
            let wire: Vec<String> = wire.iter().map(|s| canon(s)).collect();
            if call.is_ok() {
                assert_eq!(wire, golden, "{ctx}");
            } else {
                // The first refused line ends the upload.
                assert!(golden.starts_with(&wire), "{ctx}: sent {wire:?}");
            }
        } else {
            assert_eq!(sent.len(), 1, "{ctx}: sent {sent:?}");
            assert_eq!(canon(&sent[0]), canon(&ex.request), "{ctx}");
        }
    }

    for method in [
        "version",
        "caps",
        "info",
        "ping",
        "set_device_number",
        "read",
        "write",
        "state",
        "map_get",
        "map_set",
        "map_save",
        "map_default",
        "pattern_add",
        "pattern_run_once",
        "pattern_run_loop",
        "pattern_stop",
        "pattern_reset",
        "pattern_status",
        "ts_arm",
        "ts_get",
        "ts_status",
        "ts_disarm",
        "sync_arm",
        "sync_master",
        "sync_start",
        "sync_stop",
        "sync_disarm",
        "sync_count",
        "help",
        "system_reset",
        "bootsel_reset",
    ] {
        assert!(
            exercised.contains(method),
            "no golden exchange exercised `{method}`"
        );
    }
    assert!(
        local_rejections > 0,
        "expected some golden ERR cases to be refused locally"
    );
}

#[test]
fn canon_ignores_spelling_but_not_values() {
    assert_eq!(canon("PING 0xFFFFFFFF"), canon("ping 4294967295"));
    assert_eq!(
        canon("pattern add 0x1:5 0x2:0xa"),
        canon("pattern add 1:5 2:10")
    );
    assert_eq!(canon("pattern run once 3"), canon("pattern run once"));
    assert_eq!(
        canon("map set v=2 flags=0 dir=1"),
        canon("MAP SET dir=0x1 flags=0x00")
    );
    assert_ne!(canon("write 0x1 0x1"), canon("write 0x1 0x3"));
    assert_ne!(canon("pattern run loop 3"), canon("pattern run loop 4"));
}
