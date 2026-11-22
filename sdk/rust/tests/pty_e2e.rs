//! End-to-end tests against a fake firmware running on a PTY.
//!
//! The fake firmware is **not** hand-written: it answers from the v2 golden
//! transcripts (`protocol/golden/*.txt`, R-SDK-RS4 / R-C4). A test picks one
//! golden *test case* (a blank-line separated block, identified by the file
//! and the title of its `# --- ... ---` comment), drives the typed
//! [`Connection`] API through it, and the fake device replies with the
//! response recorded in the transcript, followed by the asynchronous `! ...`
//! events recorded after it.
//!
//! The replay is strict. The next command the SDK puts on the wire must equal
//! (modulo spelling: case, number base, `map set` field order) the next
//! request of the case; anything else is answered with `ERR UNKNOWN_CMD` and
//! fails the test when the device is finished. The only exception is the
//! `version` handshake `Connection` performs when it opens the port, which is
//! answered with the transcript's `version` response.
//!
//! Only the negative tests at the bottom (pre-v2 firmware, wrong `proto`,
//! silence) hand-write responses: the golden set has no such traffic by
//! definition.

use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use serialport::{SerialPort, TTYPort};
use tcapi_sdk::{
    Connection, EdgeMode, PatternMode, PatternState, PatternStep, PinMap, PushEvent, ResetCause,
    SdkError, TS_GET_MAX, VALID_DIO_MASK,
};

// ------------------------------------------------------------ golden loading

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

/// Longest request line the device accepts (the SDK refuses longer ones
/// before sending).
const MAX_LINE: usize = 256;

/// One request, the device's response lines and the events that followed
/// the response (before the next request).
#[derive(Clone, Debug)]
struct Step {
    request: String,
    response: Vec<String>,
    events: Vec<String>,
}

/// One golden test case.
#[derive(Clone, Debug)]
struct Case {
    title: String,
    steps: Vec<Step>,
    /// The case uses something a text replay cannot express: a request
    /// without a response (silence) or raw bytes (`~ send_hex`).
    replayable: bool,
}

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/golden")
}

fn parse_block(block: &[&str]) -> Option<Case> {
    let title = block
        .iter()
        .find_map(|l| l.strip_prefix("# --- "))
        .map(|t| t.trim_end_matches(" ---").to_string())
        .unwrap_or_default();
    let mut steps: Vec<Step> = Vec::new();
    let mut replayable = true;
    for line in block {
        if let Some(request) = line.strip_prefix("> ") {
            if steps.last().is_some_and(|s| s.response.is_empty()) {
                replayable = false;
            }
            steps.push(Step {
                request: request.to_string(),
                response: Vec::new(),
                events: Vec::new(),
            });
        } else if line.starts_with("~ send_hex") {
            replayable = false;
        } else if let Some(event) = line.strip_prefix("< ! ") {
            if let Some(step) = steps.last_mut() {
                step.events.push(format!("! {event}"));
            }
        } else if line.starts_with("< OK") || line.starts_with("< ERR ") {
            if let Some(step) = steps.last_mut() {
                step.response.push(line[2..].to_string());
            }
        } else if line.starts_with("<   ") {
            // Continuation line of a counted response: 2 spaces + payload.
            if let Some(step) = steps.last_mut() {
                step.response.push(line[2..].to_string());
            }
        }
    }
    if steps.last().is_some_and(|s| s.response.is_empty()) {
        replayable = false;
    }
    (!steps.is_empty()).then_some(Case {
        title,
        steps,
        replayable,
    })
}

fn load_file(file: &'static str) -> Vec<Case> {
    let path = golden_dir().join(format!("{file}.txt"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    let lines: Vec<&str> = text.lines().collect();
    lines
        .split(|l| l.trim().is_empty())
        .filter_map(parse_block)
        .collect()
}

/// The unique case of `file` titled exactly `title`, or else the unique one
/// whose title starts with it.
fn case(file: &'static str, title: &str) -> Case {
    let all = load_file(file);
    let exact: Vec<Case> = all.iter().filter(|c| c.title == title).cloned().collect();
    let mut found = if exact.is_empty() {
        all.into_iter()
            .filter(|c| c.title.starts_with(title))
            .collect()
    } else {
        exact
    };
    assert_eq!(found.len(), 1, "{file}.txt: case `{title}` must be unique");
    let case = found.remove(0);
    assert!(case.replayable, "{file}.txt: case `{title}` not replayable");
    case
}

/// The `version` response every connection handshake is answered with.
fn handshake_reply() -> Vec<String> {
    case("version-info", "version").steps[0].response.clone()
}

// ------------------------------------------------------------------- replay

/// Spelling-independent form of a command line: lower case, numbers in
/// decimal, `map set` fields sorted without the optional `v=2`.
fn canon(line: &str) -> String {
    fn number(token: &str) -> Option<u64> {
        match token
            .strip_prefix("0x")
            .or_else(|| token.strip_prefix("0X"))
        {
            Some(hex) => u64::from_str_radix(hex, 16).ok(),
            None => token.parse().ok(),
        }
    }
    let lower = line.to_ascii_lowercase();
    let mut words: Vec<String> = lower
        .split_whitespace()
        .map(|word| {
            word.split(['=', ':'])
                .map(|piece| number(piece).map_or_else(|| piece.to_string(), |n| n.to_string()))
                .collect::<Vec<_>>()
                .join(if word.contains('=') { "=" } else { ":" })
        })
        .collect();
    if words.starts_with(&["map".into(), "set".into()]) {
        let mut fields: Vec<String> = words.drain(2..).filter(|w| w != "v=2").collect();
        fields.sort();
        words.extend(fields);
    }
    words.join(" ")
}

#[derive(Default)]
struct ReplayState {
    steps: Vec<Step>,
    cursor: usize,
    /// Commands that did not match the next request of the case.
    unexpected: Vec<String>,
    greeted: bool,
}

type Shared = Arc<Mutex<ReplayState>>;

fn lock(state: &Shared) -> MutexGuard<'_, ReplayState> {
    state.lock().expect("replay state")
}

/// Answer one command line from the replay state.
fn replay(state: &Shared, hello: &[String], cmd: &str) -> Vec<String> {
    let mut st = lock(state);
    if !st.greeted {
        st.greeted = true;
        if canon(cmd) == "version" {
            return hello.to_vec();
        }
    }
    let matched = st
        .steps
        .get(st.cursor)
        .filter(|step| canon(&step.request) == canon(cmd))
        .cloned();
    match matched {
        Some(step) => {
            st.cursor += 1;
            let mut out = step.response;
            out.extend(step.events);
            out
        }
        None => {
            st.unexpected.push(cmd.to_string());
            vec!["ERR UNKNOWN_CMD".to_string()]
        }
    }
}

// -------------------------------------------------------------- PTY plumbing

/// Fake device on the master side of a PTY pair; `handler` maps each command
/// line to the lines to send back (empty = silence).
struct MockDevice {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl MockDevice {
    fn spawn(
        mut master: TTYPort,
        mut handler: impl FnMut(&str) -> Vec<String> + Send + 'static,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let handle = std::thread::spawn({
            let stop = Arc::clone(&stop);
            move || {
                master
                    .set_timeout(Duration::from_millis(20))
                    .expect("set_timeout");
                let mut acc: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 256];
                while !stop.load(Ordering::Relaxed) {
                    match master.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            acc.extend_from_slice(&chunk[..n]);
                            while let Some(pos) = acc.iter().position(|&b| b == b'\n') {
                                let line: Vec<u8> = acc.drain(..=pos).collect();
                                let cmd = String::from_utf8_lossy(&line)
                                    .trim_end_matches(['\r', '\n'])
                                    .to_string();
                                if cmd.is_empty() {
                                    continue;
                                }
                                write_lines(&mut master, &handler(&cmd));
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(_) => break,
                    }
                }
            }
        });
        Self {
            stop,
            handle: Some(handle),
        }
    }
}

/// Create a PTY pair. `TTYPort::pair` goes through `ptsname`, which is not
/// thread safe, so concurrent tests would randomly fail with "Unknown
/// errno"; creation is serialized.
fn pty_pair() -> (TTYPort, TTYPort) {
    static PAIR_LOCK: Mutex<()> = Mutex::new(());
    let _guard = PAIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    TTYPort::pair().expect("PTY pair")
}

/// Send `lines` (CR/LF terminated) to the host in one write, like one USB
/// transfer.
fn write_lines(port: &mut TTYPort, lines: &[String]) {
    if lines.is_empty() {
        return;
    }
    let wire: String = lines.iter().map(|l| format!("{l}\r\n")).collect();
    port.write_all(wire.as_bytes()).expect("mock write");
    port.flush().expect("mock flush");
}

impl Drop for MockDevice {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            // A panic of the device thread already surfaced through the
            // connection; the join result carries nothing more.
            drop(h.join());
        }
    }
}

/// A golden-replaying device plus the means to check how the replay went.
struct ReplayDevice {
    state: Shared,
    _device: MockDevice,
}

impl ReplayDevice {
    /// Switch to the next case (cases are independent: the device model is
    /// reset between them, see the golden README).
    fn load(&self, case: &Case) {
        let mut st = lock(&self.state);
        st.steps = case.steps.clone();
        st.cursor = 0;
        st.unexpected.clear();
    }

    /// Fail unless every command so far matched the case.
    fn assert_no_unexpected(&self) {
        let st = lock(&self.state);
        assert!(
            st.unexpected.is_empty(),
            "commands outside the golden case: {:?}",
            st.unexpected
        );
    }

    /// Fail unless the SDK sent every request of the case, in order, and
    /// nothing else.
    fn assert_complete(&self) {
        self.assert_no_unexpected();
        let st = lock(&self.state);
        assert_eq!(
            st.cursor,
            st.steps.len(),
            "the SDK stopped before the end of the golden case; next request: {:?}",
            st.steps.get(st.cursor).map(|s| &s.request)
        );
    }
}

fn open_replay(first: Option<&Case>) -> (Connection, ReplayDevice) {
    let state: Shared = Arc::new(Mutex::new(ReplayState {
        steps: first.map(|c| c.steps.clone()).unwrap_or_default(),
        ..ReplayState::default()
    }));
    let hello = handshake_reply();
    let (master, slave) = pty_pair();
    let device = MockDevice::spawn(master, {
        let state = Arc::clone(&state);
        move |cmd| replay(&state, &hello, cmd)
    });
    let conn = Connection::from_port(Box::new(slave)).expect("connect");
    (
        conn,
        ReplayDevice {
            state,
            _device: device,
        },
    )
}

/// Run `scenario` against the golden case and require that it consumed the
/// whole case.
fn run_case(file: &'static str, title: &str, scenario: impl FnOnce(&mut Connection)) {
    let case = case(file, title);
    let (mut conn, dev) = open_replay(Some(&case));
    scenario(&mut conn);
    dev.assert_complete();
}

/// Like [`run_case`] for a scenario that consumes the connection (`reset`,
/// `bootsel`). The golden case continues after the reset, so only
/// unexpected commands are checked.
fn run_case_consuming(file: &'static str, title: &str, scenario: impl FnOnce(Connection)) {
    let case = case(file, title);
    let (conn, dev) = open_replay(Some(&case));
    scenario(conn);
    dev.assert_no_unexpected();
}

// ------------------------------------------------------------------- helpers

/// Map B of the golden transcripts: GP0-GP3 outputs (default 0x5), GP4..
/// inputs.
fn map_b() -> PinMap {
    PinMap {
        direction: 0x0000_000f,
        pull_down: 0x0c7f_fff0,
        out_default: 0x5,
        edge: 0x0c7f_fff0,
        ..PinMap::default()
    }
}

/// The full map the golden transcripts install in `map.txt` (every field
/// non-default).
fn map_full() -> PinMap {
    PinMap {
        direction: 0x0000_000f,
        pull_up: 0x0000_00f0,
        pull_down: 0x0c7f_ff00,
        out_default: 0x5,
        out_polarity: 0x8,
        in_polarity: 0x100,
        edge: 0x0c7f_fff0,
        ..PinMap::default()
    }
}

/// Map OUT2 of the golden transcripts: GP0-GP1 outputs.
fn map_out2() -> PinMap {
    PinMap {
        direction: 0x3,
        pull_down: 0x0c7f_fffc,
        edge: 0x0c7f_fffc,
        ..PinMap::default()
    }
}

fn step(out_bits: u32, hold_ticks: u32) -> PatternStep {
    PatternStep {
        out_bits,
        hold_ticks,
    }
}

// ------------------------------------------------------- scenarios: info/ping

#[test]
fn version_matches_golden() {
    run_case("version-info", "version", |conn| {
        let v = conn.version().unwrap();
        assert_eq!(
            (v.major, v.minor, v.patch, v.protocol_version),
            (0, 1, 3, 2)
        );
    });
}

#[test]
fn caps_matches_golden() {
    run_case("version-info", "caps (example", |conn| {
        let caps = conn.caps().unwrap();
        assert_eq!(
            (caps.dio, caps.out, caps.r#in, caps.ts_res_ns, caps.tick_ns),
            (25, 0, 25, 40, 200)
        );
        assert_eq!((caps.pattern_max, caps.ring), (256, 256));
        // The transcript carries the feature mask of its firmware revision: pin
        // neither the value nor its history, only the defined bits (0..=7).
        assert_eq!(caps.features & !0xff, 0, "undefined feat bits");
        assert!(caps.has_sync() && caps.has_reset());
    });
}

#[test]
fn caps_follows_the_direction_mask() {
    run_case("version-info", "caps follows the direction mask", |conn| {
        conn.map_set(&map_out2()).unwrap();
        let caps = conn.caps().unwrap();
        assert_eq!((caps.out, caps.r#in), (2, 23));
    });
}

#[test]
fn info_and_device_number_round_trip() {
    run_case("version-info", "info: factory state", |conn| {
        let info = conn.info().unwrap();
        assert_eq!(info.uid, "0000000000000000");
        assert_eq!(info.device_number, None);
    });
    run_case("version-info", "devnum: assign, read back, clear", |conn| {
        conn.set_device_number(7).unwrap();
        assert_eq!(conn.info().unwrap().device_number, Some(7));
        conn.set_device_number(255).unwrap();
        assert_eq!(conn.info().unwrap().device_number, None);
    });
}

#[test]
fn ping_echoes_the_u32() {
    run_case("version-info", "ping echoes the u32", |conn| {
        assert_eq!(conn.ping(0).unwrap(), 0);
        assert_eq!(conn.ping(12345).unwrap(), 12345);
    });
    run_case("version-info", "ping: u32 limits", |conn| {
        assert_eq!(conn.ping(u32::MAX).unwrap(), u32::MAX);
        assert_eq!(conn.ping(0xFFFF_FFFF).unwrap(), u32::MAX);
    });
}

// ----------------------------------------------------------- scenarios: map

#[test]
fn map_set_then_get_echoes_the_map() {
    run_case("map", "map set: full map, then get echoes it", |conn| {
        conn.map_set(&map_full()).unwrap();
        assert_eq!(conn.map_get().unwrap(), map_full());
    });
}

#[test]
fn map_default_and_save_on_the_default_map() {
    run_case(
        "map",
        "map default and map save on the default map",
        |conn| {
            conn.map_default().unwrap();
            conn.map_save().unwrap();
            assert_eq!(conn.map_get().unwrap(), PinMap::default());
        },
    );
}

#[test]
fn map_set_refused_while_a_pattern_is_running() {
    run_case(
        "map",
        "map set and map default are refused while a pattern is running",
        |conn| {
            conn.map_set(&map_out2()).unwrap();
            conn.pattern_add(&[step(0x1, 100), step(0x0, 100)]).unwrap();
            conn.pattern_run_loop(1000).unwrap();
            assert!(matches!(
                conn.map_set(&map_full()).unwrap_err(),
                SdkError::Busy
            ));
            assert!(matches!(conn.map_default().unwrap_err(), SdkError::Busy));
            // `map get` is still served while the pattern runs.
            assert_eq!(conn.map_get().unwrap(), map_out2());
            // After `pattern stop` the map can be replaced again.
            conn.pattern_stop().unwrap();
            conn.map_set(&map_full()).unwrap();
            assert_eq!(conn.map_get().unwrap(), map_full());
        },
    );
}

// ------------------------------------------------------------ scenarios: io

#[test]
fn read_follows_the_driven_inputs() {
    run_case("io", "read: follows the driven input pins", |conn| {
        assert_eq!(conn.read().unwrap(), 0x0a);
        assert_eq!(conn.read().unwrap(), 0x00);
    });
}

#[test]
fn state_combines_inputs_and_the_output_latch() {
    run_case(
        "io",
        "state: combines inputs and the output latch",
        |conn| {
            conn.map_set(&map_b()).unwrap();
            let state = conn.state().unwrap();
            assert_eq!((state.inputs, state.outputs), (0x30, 0x05));
        },
    );
}

#[test]
fn write_changes_the_masked_outputs() {
    run_case("io", "write: full-mask write", |conn| {
        conn.map_set(&map_b()).unwrap();
        conn.write(0xa, 0xf).unwrap();
        assert_eq!(conn.state().unwrap().outputs, 0x0a);
    });
    run_case("io", "write: only the masked pins change", |conn| {
        conn.map_set(&map_b()).unwrap();
        conn.write(0x2, 0x3).unwrap();
        assert_eq!(conn.state().unwrap().outputs, 0x06);
    });
}

// ------------------------------------------------------- scenarios: pattern

#[test]
fn pattern_loop_reports_progress_and_done() {
    run_case(
        "pattern",
        "pattern run loop 3: loops counts completed passes",
        |conn| {
            conn.map_set(&map_out2()).unwrap();
            assert_eq!(conn.pattern_add(&[step(0x1, 5), step(0x0, 10)]).unwrap(), 2);
            conn.pattern_run(PatternMode::Loop, 3).unwrap();
            let seen: Vec<_> = (0..4)
                .map(|_| {
                    let s = conn.pattern_status().unwrap();
                    (s.state, s.step, s.loops, s.total)
                })
                .collect();
            assert_eq!(
                seen,
                [
                    (PatternState::Running, 0, 1, 2),
                    (PatternState::Running, 1, 1, 2),
                    (PatternState::Running, 1, 2, 2),
                    (PatternState::Done, 0, 3, 2),
                ]
            );
        },
    );
}

#[test]
fn pattern_stop_keeps_the_steps_loaded() {
    run_case("pattern", "pattern stop: running pattern stops", |conn| {
        conn.map_set(&map_out2()).unwrap();
        conn.pattern_add(&[step(0x1, 5), step(0x0, 10)]).unwrap();
        conn.pattern_run_loop(5).unwrap();
        conn.pattern_stop().unwrap();
        let s = conn.pattern_status().unwrap();
        assert_eq!((s.state, s.total), (PatternState::Loaded, 2));
        conn.pattern_run_once().unwrap();
    });
}

#[test]
fn pattern_stop_when_not_running_is_typed() {
    run_case("pattern", "pattern stop: not running is refused", |conn| {
        let not_running = |conn: &mut Connection| {
            assert!(matches!(
                conn.pattern_stop().unwrap_err(),
                SdkError::NotRunning
            ));
        };
        conn.map_set(&map_out2()).unwrap();
        not_running(conn); // idle
        conn.pattern_add(&[step(0x1, 5), step(0x0, 10)]).unwrap();
        not_running(conn); // loaded
        conn.pattern_run_once().unwrap();
        not_running(conn); // done (the pattern finished by itself)
        assert_eq!(conn.pattern_status().unwrap().state, PatternState::Done);
    });
}

#[test]
fn pattern_reset_clears_the_loaded_steps() {
    run_case("pattern", "pattern reset: clears loaded steps", |conn| {
        conn.map_set(&map_out2()).unwrap();
        conn.pattern_add(&[step(0x1, 5), step(0x0, 10)]).unwrap();
        conn.pattern_reset().unwrap();
        let s = conn.pattern_status().unwrap();
        assert_eq!((s.state, s.total), (PatternState::Idle, 0));
        // Nothing loaded: running is refused as BAD_PARAM.
        assert!(matches!(
            conn.pattern_run_once().unwrap_err(),
            SdkError::BadParam
        ));
    });
}

#[test]
fn pattern_add_after_reset_counts_from_zero() {
    run_case(
        "pattern",
        "pattern reset: a fresh add after reset starts counting from zero",
        |conn| {
            conn.map_set(&map_out2()).unwrap();
            assert_eq!(conn.pattern_add(&[step(0x1, 5), step(0x0, 10)]).unwrap(), 2);
            conn.pattern_reset().unwrap();
            assert_eq!(conn.pattern_add(&[step(0x1, 5)]).unwrap(), 1);
        },
    );
}

#[test]
fn pattern_buffer_holds_exactly_256_steps() {
    run_case(
        "boundary",
        "256 pattern steps are accepted, the 257th is refused",
        |conn| {
            // 256 one-tick steps go out as several lines within the line limit.
            let steps = vec![step(0, 1); 256];
            assert_eq!(conn.pattern_add(&steps).unwrap(), 256);
            assert_eq!(conn.pattern_status().unwrap().total, 256);
            assert!(matches!(
                conn.pattern_add(&steps[..1]).unwrap_err(),
                SdkError::TooLong
            ));
            // The refused step changed nothing.
            let status = conn.pattern_status().unwrap();
            assert_eq!((status.state, status.total), (PatternState::Loaded, 256));
        },
    );
}

// ----------------------------------------------------- scenarios: timestamp

#[test]
fn ts_arm_status_get_disarm() {
    run_case(
        "timestamp",
        "ts arm then status, get with no events returns count=0",
        |conn| {
            conn.ts_arm(0x1, EdgeMode::Rising).unwrap();
            let status = conn.ts_status().unwrap();
            assert!(status.armed && !status.overflow);
            assert_eq!(status.pending, 0);
            let result = conn.ts_get(5).unwrap();
            assert!(result.events.is_empty() && !result.overflow);
            conn.ts_disarm().unwrap();
            assert!(!conn.ts_status().unwrap().armed);
        },
    );
}

#[test]
fn ts_get_returns_the_recorded_events() {
    run_case(
        "timestamp",
        "ts rising: only logical rising edges are recorded",
        |conn| {
            conn.ts_arm(0x1, EdgeMode::Rising).unwrap();
            assert_eq!(conn.ts_status().unwrap().pending, 2);
            let result = conn.ts_get(10).unwrap();
            let seen: Vec<_> = result
                .events
                .iter()
                .map(|e| (e.inputs, e.raw_count, e.raw_phase, e.sync_active))
                .collect();
            assert_eq!(seen, [(1, 1000, 0, false), (1, 1500, 0, false)]);
            // Free running: ns is the microsecond count alone (R-TS1).
            assert_eq!(result.events[1].ns(40), 1_500_000);
            assert_eq!(conn.ts_status().unwrap().pending, 0);
        },
    );
}

#[test]
fn ts_get_drains_in_batches() {
    run_case(
        "timestamp",
        "ts get consumes events: max limits the batch",
        |conn| {
            conn.ts_arm(0x1, EdgeMode::Both).unwrap();
            let first = conn.ts_get(2).unwrap();
            assert_eq!(first.events.len(), 2);
            assert_eq!(conn.ts_status().unwrap().pending, 1);
            assert_eq!(conn.ts_get(2).unwrap().events.len(), 1);
            // Empty again; the connection is still in sync (counted read).
            assert!(conn.ts_get(2).unwrap().events.is_empty());
        },
    );
}

#[test]
fn ts_get_overflow_flag_propagates() {
    run_case("timestamp", "ts ring overflow: the oldest events", |conn| {
        conn.ts_arm(0x1, EdgeMode::Both).unwrap();
        let status = conn.ts_status().unwrap();
        assert_eq!((status.pending, status.overflow), (256, true));

        let first = conn.ts_get(5).unwrap();
        assert!(first.overflow, "overflow is reported on the first get");
        assert_eq!(first.events.len(), 5);
        assert_eq!(first.events[0].raw_count, 20);

        let status = conn.ts_status().unwrap();
        assert_eq!((status.pending, status.overflow), (251, false));
        let second = conn.ts_get(2).unwrap();
        assert!(!second.overflow, "overflow is reported once");
        assert_eq!(second.events[0].raw_count, 70);
    });
}

#[test]
fn ts_get_before_arm_is_not_armed() {
    run_case("timestamp", "ts get: not armed", |conn| {
        assert!(matches!(conn.ts_get(1).unwrap_err(), SdkError::NotArmed));
        // Disarming discards the capture state: get is refused again.
        conn.ts_arm(0x1, EdgeMode::Both).unwrap();
        conn.ts_disarm().unwrap();
        assert!(matches!(conn.ts_get(1).unwrap_err(), SdkError::NotArmed));
    });
}

#[test]
fn ts_get_max_outside_the_accepted_range_is_refused_locally() {
    // `ts get 0` / `ts get 86` never reach the wire: the SDK's own range
    // check answers (the device would say BAD_PARAM, see the golden case).
    let (mut conn, dev) = open_replay(None);
    assert!(matches!(
        conn.ts_get(0).unwrap_err(),
        SdkError::InvalidArgument(_)
    ));
    assert!(matches!(
        conn.ts_get(TS_GET_MAX + 1).unwrap_err(),
        SdkError::InvalidArgument(_)
    ));
    dev.assert_complete();
}

#[test]
fn ts_arm_twice_is_busy() {
    run_case(
        "timestamp",
        "ts arm: arming twice is refused and keeps the first arm",
        |conn| {
            conn.ts_arm(0x1, EdgeMode::Rising).unwrap();
            assert!(matches!(
                conn.ts_arm(0x2, EdgeMode::Falling).unwrap_err(),
                SdkError::Busy
            ));
            let result = conn.ts_get(10).unwrap();
            assert_eq!(result.events.len(), 1);
            assert_eq!(result.events[0].inputs, 0x1);
        },
    );
}

#[test]
fn ts_under_sync_feeds_the_reconcile_pipeline() {
    run_case("timestamp", "ts under sync: s=1", |conn| {
        conn.sync_master().unwrap();
        conn.sync_start().unwrap();
        conn.ts_arm(0x1, EdgeMode::Both).unwrap();
        conn.sync_stop().unwrap();
        let result = conn.ts_get(10).unwrap();
        let seen: Vec<_> = result
            .events
            .iter()
            .map(|e| (e.inputs, e.raw_count, e.raw_phase, e.sync_active))
            .collect();
        assert_eq!(
            seen,
            [
                (1, 2, 12, true),
                (0, 3, 24, true),
                (1, 4, 0, true),
                (0, 107, 0, false),
            ]
        );
        // R-TS1: with sync active ns = count * 1000 + phase * ts_res_ns.
        assert_eq!(result.events[0].ns(40), 2_480);
        assert_eq!(result.events[1].ns(40), 3_960);
        assert_eq!(result.events[3].ns(40), 107_000);

        // ts_get -> SourceEvent -> group_events, end to end.
        let source: Vec<tcapi_sdk::reconcile::SourceEvent> = result
            .events
            .iter()
            .map(|ev| tcapi_sdk::reconcile::SourceEvent {
                device: "local".to_string(),
                channel: format!("GP{}", ev.inputs.trailing_zeros().min(31)),
                inputs: format!("0x{:08X}", ev.inputs),
                raw_count: ev.raw_count,
                raw_phase: ev.raw_phase,
                sync_active: ev.sync_active,
            })
            .collect();
        let groups = tcapi_sdk::reconcile::group_events(&source, 40);
        // Counts 2 and 3 share a group (within +-1); 4 and 107 stand alone.
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].events.len(), 2);
        assert!(groups[0].reconciled);
        let as_is_spread = 3_960 - 2_480;
        let spread = (groups[0].reconciled_ns[0] - groups[0].reconciled_ns[1]).abs();
        assert!(spread <= as_is_spread, "reconcile must not widen the pair");
        assert!(!groups[1].reconciled && !groups[2].reconciled);
    });
}

// ---------------------------------------------------------- scenarios: sync

#[test]
fn sync_master_start_count_stop() {
    run_case("sync", "sync master -> start -> count -> stop", |conn| {
        conn.sync_master().unwrap();
        conn.sync_start().unwrap();
        // `sync count` is a single `OK clocks=N` line: no counted read.
        let counts: Vec<u64> = (0..4).map(|_| conn.sync_count().unwrap()).collect();
        assert_eq!(counts, [0, 1000, 1000, 1001]);
        conn.sync_stop().unwrap();
        assert!(matches!(
            conn.sync_count().unwrap_err(),
            SdkError::SyncState
        ));
    });
}

#[test]
fn sync_state_errors_are_typed() {
    run_case(
        "sync",
        "sync arm: slave-armed state, every other transition is refused",
        |conn| {
            conn.sync_arm().unwrap();
            assert!(matches!(conn.sync_arm().unwrap_err(), SdkError::SyncState));
            assert!(matches!(
                conn.sync_master().unwrap_err(),
                SdkError::SyncState
            ));
            assert!(matches!(
                conn.sync_start().unwrap_err(),
                SdkError::SyncState
            ));
            assert!(matches!(conn.sync_stop().unwrap_err(), SdkError::SyncState));
            assert!(matches!(
                conn.sync_count().unwrap_err(),
                SdkError::SyncState
            ));
        },
    );
    run_case("sync", "sync disarm is always OK, also when idle", |conn| {
        conn.sync_disarm().unwrap();
        conn.sync_disarm().unwrap();
    });
}

// --------------------------------------------------------- scenarios: events

#[test]
fn input_events_are_pushed_after_subscribe() {
    run_case("events", "INPUT: every change on an edge pin", |conn| {
        let events = conn.subscribe_events().unwrap();
        let timeout = Duration::from_secs(1);
        assert_eq!(
            events.recv_timeout(timeout).unwrap(),
            PushEvent::InputChange { inputs: 1, t_us: 5 }
        );
        assert_eq!(
            events.recv_timeout(timeout).unwrap(),
            PushEvent::InputChange { inputs: 0, t_us: 8 }
        );
    });
}

#[test]
fn pattern_done_and_input_events_arrive_in_order() {
    run_case(
        "events",
        "PATTERN_DONE and INPUT interleave in time order",
        |conn| {
            conn.map_set(&map_out2()).unwrap();
            let events = conn.subscribe_events().unwrap();
            conn.pattern_add(&[step(0x1, 5), step(0x0, 10)]).unwrap();
            conn.pattern_run_once().unwrap();

            let timeout = Duration::from_secs(1);
            let seen: Vec<PushEvent> = (0..3)
                .map(|_| events.recv_timeout(timeout).unwrap())
                .collect();
            assert_eq!(
                seen,
                [
                    PushEvent::InputChange {
                        inputs: 0x10,
                        t_us: 2
                    },
                    PushEvent::PatternDone { loops: 1 },
                    PushEvent::InputChange { inputs: 0, t_us: 4 },
                ]
            );
        },
    );
}

#[test]
fn pattern_done_is_pushed_without_input_changes() {
    run_case(
        "events",
        "PATTERN_DONE: with subscribe on it is still a single event",
        |conn| {
            conn.map_set(&map_out2()).unwrap();
            let events = conn.subscribe_events().unwrap();
            conn.pattern_add(&[step(0x1, 5), step(0x0, 10)]).unwrap();
            conn.pattern_run_once().unwrap();
            assert_eq!(
                events.recv_timeout(Duration::from_secs(1)).unwrap(),
                PushEvent::PatternDone { loops: 1 }
            );
        },
    );
}

// ---------------------------------------------------------- scenarios: reset

#[test]
fn system_reset_consumes_the_connection() {
    run_case_consuming("reset", "reset: acknowledges", |conn| {
        conn.system_reset().unwrap();
    });
}

#[test]
fn bootsel_reset_consumes_the_connection() {
    run_case_consuming("reset", "bootsel: acknowledges", |conn| {
        conn.bootsel_reset().unwrap();
    });
}

#[test]
fn help_is_a_counted_response() {
    let golden = case("reset", "help: counted response");
    // The command list grows with the firmware: the transcript decides how
    // many lines there are (its first response line is the `OK count=N`
    // header); `version` stays first and `help` last.
    let expected = golden.steps[0].response.len() - 1;
    run_case("reset", "help: counted response", |conn| {
        let lines = conn.help().unwrap();
        assert_eq!(lines.len(), expected, "help lines vs the golden transcript");
        assert!(lines[0].trim_start().starts_with("version"));
        assert!(lines[lines.len() - 1].trim_start().starts_with("help"));
    });
}

// -------------------------------------------------------- scenarios: safety

/// MAP A of `protocol/golden/safety.txt`: GP0-GP3 outputs, default 0.
fn safety_map_a() -> PinMap {
    PinMap::parse_get(
        "v=2 flags=0x00 dir=0x0000000f pu=0x00000000 pd=0x0c7ffff0 def=0x00000000 \
         opol=0x00000000 ipol=0x00000000 edge=0x0c7ffff0",
    )
    .unwrap()
}

#[test]
fn exclusive_violations_are_typed_with_group_and_mask() {
    run_case("safety", "safety_excl_violation_rejected_whole", |conn| {
        conn.map_set(&safety_map_a()).unwrap();
        conn.excl_set(&[0xc]).unwrap();
        conn.write(0x4, 0x4).unwrap();
        let violation = |r: Result<(), SdkError>| match r {
            Err(SdkError::Exclusive { group, mask }) => assert_eq!((group, mask), (0, 0xc)),
            other => panic!("{other:?}"),
        };
        violation(conn.write(0x8, 0x8));
        assert_eq!(conn.state().unwrap().outputs, 0x4);
        violation(conn.write(0xc, 0xc));
        violation(conn.write(0xf, 0xf));
        assert_eq!(conn.state().unwrap().outputs, 0x4);
        conn.excl_set(&[0x3, 0xc]).unwrap();
        conn.write(0x4, 0xf).unwrap();
        assert!(matches!(
            conn.write(0x7, 0x7),
            Err(SdkError::Exclusive {
                group: 0,
                mask: 0x3
            })
        ));
        assert!(matches!(
            conn.write(0x8, 0x8),
            Err(SdkError::Exclusive {
                group: 1,
                mask: 0xc
            })
        ));
        conn.write(0x1, 0x3).unwrap();
        assert_eq!(conn.state().unwrap().outputs, 0x5);
    });
}

#[test]
fn exclusive_groups_round_trip_through_excl_get() {
    run_case("safety", "safety_excl_set_get_roundtrip", |conn| {
        conn.map_set(
            &PinMap::parse_get(
                "v=2 flags=0x00 dir=0x0000ffff pu=0x00000000 pd=0x0c7f0000 def=0x00000000 \
             opol=0x00000000 ipol=0x00000000 edge=0x0c7f0000",
            )
            .unwrap(),
        )
        .unwrap();
        assert!(conn.excl_get().unwrap().is_empty());
        conn.excl_set(&[0xc]).unwrap();
        assert_eq!(conn.excl_get().unwrap(), [0xc]);
        conn.excl_set(&[0x3, 0xc]).unwrap();
        assert_eq!(conn.excl_get().unwrap(), [0x3, 0xc]);
        assert_eq!(conn.safety().unwrap().excl, 2);
        conn.excl_clear().unwrap();
        assert!(conn.excl_get().unwrap().is_empty());
        // The upper-case spelling goes through the raw path.
        assert_eq!(
            conn.raw("EXCL SET 0x3 0xc 0x30 0xc0 0x300 0xc00 0x3000 0xc000")
                .unwrap(),
            ["OK"]
        );
        assert_eq!(conn.excl_get().unwrap().len(), 8);
        let sixteen = [
            0x3, 0xc, 0x30, 0xc0, 0x300, 0xc00, 0x3000, 0xc000, 0x5, 0xa, 0x50, 0xa0, 0x500, 0xa00,
            0x5000, 0xa000,
        ];
        conn.excl_set(&sixteen).unwrap();
        assert_eq!(conn.excl_get().unwrap(), sixteen);
        // 17 groups never leave the host; the device answered BAD_PARAM.
        let mut seventeen = sixteen.to_vec();
        seventeen.push(0x9);
        assert!(matches!(
            conn.excl_set(&seventeen),
            Err(SdkError::InvalidArgument(_))
        ));
        assert!(matches!(
            conn.raw(&format!(
                "excl set {}",
                seventeen
                    .iter()
                    .map(|m| format!("{m:#x}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            ))
            .unwrap()[0]
                .as_str(),
            "ERR BAD_PARAM"
        ));
        assert_eq!(conn.safety().unwrap().excl, 16);
        conn.excl_clear().unwrap();
        assert!(conn.excl_get().unwrap().is_empty());
    });
}

#[test]
fn the_failsafe_latch_is_a_typed_error() {
    run_case("safety", "safety_failsafe_latch_rejects_on", |conn| {
        conn.map_set(&safety_map_a()).unwrap();
        conn.wdog(100).unwrap();
        assert!(matches!(conn.write(0x1, 0x1), Err(SdkError::Failsafe)));
        assert!(matches!(conn.write(0x2, 0x2), Err(SdkError::Failsafe)));
        assert!(matches!(conn.write(0xf, 0xf), Err(SdkError::Failsafe)));
        conn.pattern_add(&[step(0x1, 5), step(0x0, 10)]).unwrap();
        assert!(matches!(conn.pattern_run_once(), Err(SdkError::Failsafe)));
        assert!(matches!(conn.pattern_run_loop(3), Err(SdkError::Failsafe)));
        assert!(matches!(
            conn.map_set(&safety_map_a()),
            Err(SdkError::Failsafe)
        ));
        assert!(matches!(conn.map_default(), Err(SdkError::Failsafe)));
        assert_eq!(conn.pattern_status().unwrap().total, 2);
        assert_eq!(conn.state().unwrap().outputs, 0);
    });
}

#[test]
fn rstinfo_and_pads_match_the_golden_transcripts() {
    run_case("safety", "safety_rstinfo_initial", |conn| {
        let info = conn.rstinfo().unwrap();
        assert_eq!(
            (info.cause, info.uptime_ms, info.boot),
            (ResetCause::Por, 0, 1)
        );
        let info = conn.rstinfo().unwrap();
        assert_eq!(info.uptime_ms, 1500);
        assert_eq!(conn.raw("RSTINFO 1").unwrap(), ["ERR BAD_PARAM"]);
    });
    run_case("safety", "safety_pads_reports_out_and_pad", |conn| {
        conn.map_set(
            &PinMap::parse_get(
                "v=2 flags=0x00 dir=0x0000000f pu=0x00000000 pd=0x0c7ffff0 def=0x00000000 \
                 opol=0x00000001 ipol=0x00000000 edge=0x0c7ffff0",
            )
            .unwrap(),
        )
        .unwrap();
        let pads = conn.pads().unwrap();
        assert_eq!((pads.out, pads.pad), (0, 0));
        conn.write(0x5, 0x5).unwrap();
        let pads = conn.pads().unwrap();
        assert_eq!((pads.out, pads.pad), (5, 5));
        assert_eq!(conn.raw("PADS 1").unwrap(), ["ERR BAD_PARAM"]);
    });
}

// ---------------------------------------------------------- scenarios: errors

#[test]
fn busy_errors_are_typed() {
    run_case(
        "errors",
        "ERR BUSY: pattern add and map set while running",
        |conn| {
            conn.map_set(&map_b()).unwrap();
            conn.pattern_add(&[step(0x1, 5), step(0x0, 10)]).unwrap();
            conn.pattern_run_loop(5).unwrap();
            assert!(matches!(
                conn.pattern_add(&[step(0x1, 5)]).unwrap_err(),
                SdkError::Busy
            ));
            assert!(matches!(conn.map_default().unwrap_err(), SdkError::Busy));
            assert!(matches!(
                conn.pattern_run_once().unwrap_err(),
                SdkError::Busy
            ));
            conn.ts_arm(0x10, EdgeMode::Both).unwrap();
            assert!(matches!(
                conn.ts_arm(0x10, EdgeMode::Both).unwrap_err(),
                SdkError::Busy
            ));
        },
    );
}

#[test]
fn flash_errors_are_typed_and_leave_state_unchanged() {
    run_case("errors", "ERR FLASH: map save and devnum", |conn| {
        assert!(matches!(conn.map_save().unwrap_err(), SdkError::Flash));
        conn.map_save().unwrap();
        conn.set_device_number(4).unwrap();
        assert!(matches!(
            conn.set_device_number(5).unwrap_err(),
            SdkError::Flash
        ));
        assert_eq!(conn.info().unwrap().device_number, Some(4));
    });
}

#[test]
fn no_resource_errors_are_typed() {
    run_case("errors", "ERR NO_RESOURCE", |conn| {
        assert!(matches!(
            conn.write(0x1, 0x1).unwrap_err(),
            SdkError::NoResource
        ));
        let all_out = PinMap {
            direction: VALID_DIO_MASK,
            pull_down: 0,
            edge: 0,
            ..PinMap::default()
        };
        conn.map_set(&all_out).unwrap();
        assert!(matches!(conn.read().unwrap_err(), SdkError::NoResource));
        assert!(matches!(
            conn.ts_arm(0x1, EdgeMode::Both).unwrap_err(),
            SdkError::NoResource
        ));
        assert!(matches!(
            conn.subscribe_events().unwrap_err(),
            SdkError::NoResource
        ));
    });
}

#[test]
fn an_error_leaves_the_connection_usable() {
    run_case("errors", "an error leaves the device usable", |conn| {
        assert_eq!(
            conn.raw("nonsense").unwrap(),
            ["ERR UNKNOWN_CMD".to_string()]
        );
        assert_eq!(conn.ping(1).unwrap(), 1);
        assert!(matches!(conn.ts_get(1).unwrap_err(), SdkError::NotArmed));
        assert_eq!(conn.version().unwrap().protocol_version, 2);
    });
}

// ---------------------------------------------------- raw golden transcript

/// Send every request of every replayable golden case through the `raw`
/// escape hatch and require the device's recorded response, line for line.
/// This puts the whole golden corpus (not only the typed scenarios above)
/// through the PTY transport: counted responses, `ERR` lines, unknown
/// commands and boundary lengths.
#[test]
fn raw_replays_the_whole_golden_corpus() {
    let (mut conn, dev) = open_replay(None);
    let mut replayed = 0usize;
    let mut requests = BTreeSet::new();
    for file in GOLDEN_FILES {
        for case in load_file(file) {
            // The SDK owns `subscribe` and refuses over-long lines locally.
            let skipped = !case.replayable
                || case.steps.iter().any(|s| {
                    s.request.len() > MAX_LINE
                        || s.request.is_empty()
                        || canon(&s.request).starts_with("subscribe")
                });
            if skipped {
                continue;
            }
            dev.load(&case);
            for step in &case.steps {
                let lines = conn.raw(&step.request).unwrap_or_else(|e| {
                    panic!("{file}.txt `{}`: `{}`: {e}", case.title, step.request)
                });
                assert_eq!(
                    lines, step.response,
                    "{file}.txt `{}`: `{}`",
                    case.title, step.request
                );
                requests.insert(canon(&step.request));
            }
            dev.assert_complete();
            replayed += 1;
        }
    }
    assert!(replayed > 200, "only {replayed} golden cases replayed");
    assert!(
        requests.len() > 150,
        "only {} distinct requests",
        requests.len()
    );
}

// --------------------------------------------- negative tests (hand-written)

/// Hand-written fake firmware for the negative scenarios the golden set
/// cannot contain: pre-v2 replies, a wrong `proto`, silence.
fn spawn_negative(
    handler: impl FnMut(&str) -> Vec<String> + Send + 'static,
) -> (Result<Connection, SdkError>, MockDevice) {
    let (master, slave) = pty_pair();
    let device = MockDevice::spawn(master, handler);
    (Connection::from_port(Box::new(slave)), device)
}

#[test]
fn v1_shaped_replies_fail_loudly() {
    let (conn, _dev) = spawn_negative(|cmd| match cmd.split_whitespace().next() {
        Some("version") => vec!["OK fw=0.1.3 proto=2".into()],
        // v1 `caps`: ts_res=1000ns, no tick_ns.
        Some("caps") => {
            vec!["OK dio=23 out=12 in=11 ts_res=1000ns pattern=256 ring=256 feat=0x00000001".into()]
        }
        Some("ts") if cmd.starts_with("ts arm") => vec!["OK".into()],
        // v1 `ts get`: no overflow=, lines use `t=`.
        Some("ts") => vec!["OK count=1".into(), "  0x00000005 t=1234567890".into()],
        _ => vec!["ERR UNKNOWN_CMD".into()],
    });
    let mut conn = conn.expect("connect");
    assert!(matches!(conn.caps().unwrap_err(), SdkError::Parse(_)));
    conn.ts_arm(0x01, EdgeMode::Rising).unwrap();
    assert!(matches!(conn.ts_get(10).unwrap_err(), SdkError::Parse(_)));
}

#[test]
fn proto_other_than_2_fails_the_connection() {
    for proto in [1, 3] {
        let (conn, _dev) = spawn_negative(move |cmd| {
            if cmd == "version" {
                vec![format!("OK fw=0.1.3 proto={proto}")]
            } else {
                vec!["ERR UNKNOWN_CMD".into()]
            }
        });
        assert!(
            matches!(conn.err(), Some(SdkError::UnsupportedFirmware(_))),
            "proto={proto} must be refused"
        );
    }
}

#[test]
fn timeout_then_ping_resync_recovers() {
    let mut silent_once = true;
    let handshake = handshake_reply();
    let (conn, _dev) = spawn_negative(move |cmd| match cmd {
        "version" => handshake.clone(),
        "read" if silent_once => {
            silent_once = false;
            vec![]
        }
        "read" => vec!["OK in=0x00000005".into()],
        other => other
            .strip_prefix("ping ")
            .map(|n| vec![format!("OK pong={n}")])
            .unwrap_or_else(|| vec!["ERR UNKNOWN_CMD".into()]),
    });
    let mut conn = conn.expect("connect");
    conn.set_timeout(Duration::from_millis(200));
    assert!(matches!(conn.read().unwrap_err(), SdkError::Timeout));

    // The same connection recovers: the next command resyncs with `ping`
    // first and then works.
    assert_eq!(conn.read().unwrap(), 0x05);
    assert_eq!(conn.version().unwrap().minor, 1);
}

#[test]
fn host_side_validation_never_reaches_the_device() {
    // No case is loaded: any command that did reach the device would be
    // recorded as unexpected.
    let (mut conn, dev) = open_replay(None);
    let bad_map = PinMap {
        pull_up: 0b1,
        pull_down: 0b1,
        ..PinMap::default()
    };
    assert!(matches!(
        conn.map_set(&bad_map).unwrap_err(),
        SdkError::InvalidArgument(_)
    ));
    // The SDK owns `subscribe`; raw refuses it.
    assert!(matches!(
        conn.raw("subscribe on").unwrap_err(),
        SdkError::InvalidArgument(_)
    ));
    // A line over the 256-byte limit is refused before sending.
    let long = format!("ping {}", "9".repeat(MAX_LINE));
    assert!(matches!(
        conn.raw(&long).unwrap_err(),
        SdkError::InvalidArgument(_)
    ));
    dev.assert_complete();
}
