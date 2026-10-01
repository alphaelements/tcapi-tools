//! End-to-end tests against a mock firmware running on a PTY.
//!
//! The mock implements the v2 text command set with enough state
//! (outputs, pin map, pattern, ts ring, sync, subscription) to exercise the
//! full `Connection` API including counted reads, push event multiplexing,
//! device errors, and pre-v2 firmware rejection.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use pochi_sdk::{
    Connection, EdgeMode, PatternMode, PatternState, PatternStep, PinMap, PushEvent, SdkError,
    VALID_DIO_MASK,
};
use serialport::{SerialPort, TTYPort};

/// Mock device state.
struct MockFw {
    outputs: u32,
    inputs: u32,
    map: PinMap,
    subscribed: bool,
    pattern_loaded: u16,
    pattern_state: &'static str,
    ts_armed: bool,
    ts_events: Vec<&'static str>,
    ts_overflow: bool,
    sync_clocking: bool,
    /// Reply with the pre-v2 (v1) formats.
    old_firmware: bool,
}

impl MockFw {
    fn new() -> Self {
        Self {
            outputs: 0,
            inputs: 0x05,
            map: PinMap::default(),
            subscribed: false,
            pattern_loaded: 0,
            pattern_state: "idle",
            ts_armed: false,
            ts_events: vec![
                "  in=0x00000005 c=1000 p=7 s=1",
                "  in=0x0000000a c=2000 p=12 s=0",
            ],
            ts_overflow: false,
            sync_clocking: false,
            old_firmware: false,
        }
    }

    /// Process one command line, returning response lines to send.
    fn handle(&mut self, cmd: &str) -> Vec<String> {
        let cmd = cmd.trim();
        let lower = cmd.to_lowercase();
        let parts: Vec<&str> = lower.split_whitespace().collect();
        match parts.as_slice() {
            ["version"] => vec!["OK fw=0.1.3 proto=2".into()],
            ["caps"] => {
                if self.old_firmware {
                    vec![
                        "OK dio=23 out=12 in=11 ts_res=1000ns pattern=256 ring=256 feat=0x00000001"
                            .into(),
                    ]
                } else {
                    vec![
                        "OK dio=25 out=12 in=13 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 \
                         feat=0x00000003"
                            .into(),
                    ]
                }
            }
            ["info"] => vec!["OK uid=AABBCCDD11223344 devnum=42".into()],
            ["devnum", n] => match n.parse::<u16>() {
                Ok(0..=255) => vec!["OK".into()],
                _ => vec!["ERR BAD_PARAM".into()],
            },
            ["read"] => vec![format!("OK in=0x{:08x}", self.inputs)],
            ["write", values, mask] => {
                let v = parse_num(values);
                let m = parse_num(mask);
                match (v, m) {
                    (Some(v), Some(m)) => {
                        self.outputs = (self.outputs & !m) | (v & m);
                        vec!["OK".into()]
                    }
                    _ => vec!["ERR BAD_PARAM".into()],
                }
            }
            ["state"] => vec![format!(
                "OK in=0x{:08x} out=0x{:08x}",
                self.inputs, self.outputs
            )],
            ["map", "get"] => vec![format!(
                "OK {}",
                self.map.to_set_args().expect("mock map is valid")
            )],
            ["map", "set", ..] => {
                let args = lower.strip_prefix("map set ").unwrap_or_default();
                match pochi_sdk::protocol::parse_map(args) {
                    Ok(map) => {
                        self.map = map;
                        vec!["OK".into()]
                    }
                    Err(_) => vec!["ERR BAD_MAP".into()],
                }
            }
            ["map", "save"] => vec!["OK".into()],
            ["map", "default"] => {
                self.map = PinMap::default();
                vec!["OK".into()]
            }
            ["subscribe", "on"] => {
                self.subscribed = true;
                vec!["OK".into()]
            }
            ["subscribe", "off"] => {
                self.subscribed = false;
                vec!["OK".into()]
            }
            ["pattern", "add", steps @ ..] => {
                let valid = !steps.is_empty()
                    && steps.iter().all(|step| {
                        step.split_once(':').is_some_and(|(bits, ticks)| {
                            parse_num(bits).is_some() && ticks.parse::<u32>().is_ok_and(|t| t > 0)
                        })
                    });
                if !valid {
                    return vec!["ERR BAD_PARAM".into()];
                }
                let total = usize::from(self.pattern_loaded) + steps.len();
                if total > 256 {
                    return vec!["ERR TOO_LONG".into()];
                }
                self.pattern_loaded = total as u16;
                self.pattern_state = "loaded";
                vec![format!("OK total={total}")]
            }
            ["pattern", "run", _, _] => {
                if self.pattern_loaded == 0 {
                    vec!["ERR BAD_PARAM".into()]
                } else if self.pattern_state == "running" {
                    vec!["ERR BUSY".into()]
                } else {
                    self.pattern_state = "running";
                    vec!["OK".into()]
                }
            }
            ["pattern", "stop"] => {
                if self.pattern_state != "running" {
                    vec!["ERR NOT_RUNNING".into()]
                } else {
                    self.pattern_state = if self.pattern_loaded > 0 {
                        "loaded"
                    } else {
                        "idle"
                    };
                    vec!["OK".into()]
                }
            }
            ["pattern", "status"] => {
                vec![format!(
                    "OK state={} step=0 loops=0 total={}",
                    self.pattern_state, self.pattern_loaded
                )]
            }
            ["pattern", "reset"] => {
                self.pattern_state = "idle";
                self.pattern_loaded = 0;
                vec!["OK".into()]
            }
            ["reset"] | ["bootsel"] => {
                // FW would drain TX then re-enumerate. The mock just ACKs.
                vec!["OK".into()]
            }
            ["ts", "arm", _, _] => {
                if self.ts_armed {
                    vec!["ERR BUSY".into()]
                } else {
                    self.ts_armed = true;
                    vec!["OK".into()]
                }
            }
            ["ts", "get", max] => {
                if !self.ts_armed {
                    return vec!["ERR NOT_ARMED".into()];
                }
                let max: usize = max.parse().unwrap_or(0);
                if self.old_firmware {
                    // v1 omitted overflow= and used the `t=` ts format.
                    return vec!["OK count=1".into(), "  0x00000005 t=1234567890".into()];
                }
                let events: Vec<String> = self
                    .ts_events
                    .iter()
                    .take(max)
                    .map(|s| s.to_string())
                    .collect();
                let overflow_flag = if self.ts_overflow { 1 } else { 0 };
                let mut lines = vec![format!(
                    "OK count={} overflow={overflow_flag}",
                    events.len()
                )];
                lines.extend(events);
                lines
            }
            ["ts", "disarm"] => {
                self.ts_armed = false;
                vec!["OK".into()]
            }
            ["sync", "arm"] | ["sync", "master"] => vec!["OK".into()],
            ["sync", "start"] => {
                self.sync_clocking = true;
                vec!["OK".into()]
            }
            ["sync", "stop"] => {
                self.sync_clocking = false;
                vec!["OK".into()]
            }
            ["sync", "count"] => {
                if self.sync_clocking {
                    // Single line `OK clocks=N`; no data lines follow.
                    vec!["OK clocks=1000000".into()]
                } else {
                    vec!["ERR SYNC_STATE".into()]
                }
            }
            ["sync", "disarm"] => vec!["OK".into()],
            _ => vec!["ERR UNKNOWN_CMD".into()],
        }
    }
}

fn parse_num(s: &str) -> Option<u32> {
    if let Some(hex) = s.strip_prefix("0x") {
        u32::from_str_radix(hex, 16).ok()
    } else {
        s.parse().ok()
    }
}

/// Mock device running on the master side of a PTY pair.
struct MockDevice {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl MockDevice {
    /// Spawn the mock. `pre_push` lines are injected before each response
    /// (to exercise push/response multiplexing).
    fn spawn(mut master: TTYPort, mut fw: MockFw, pre_push: Vec<&'static str>) -> Self {
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
                                for push in &pre_push {
                                    write_line(&mut master, push);
                                }
                                for resp in fw.handle(&cmd) {
                                    write_line(&mut master, &resp);
                                }
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

fn write_line(port: &mut TTYPort, line: &str) {
    port.write_all(line.as_bytes()).expect("mock write");
    port.write_all(b"\r\n").expect("mock write");
    port.flush().expect("mock flush");
}

impl Drop for MockDevice {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn connect_mock(fw: MockFw, pre_push: Vec<&'static str>) -> (Connection, MockDevice) {
    let (master, slave) = TTYPort::pair().expect("PTY pair");
    let device = MockDevice::spawn(master, fw, pre_push);
    let conn = Connection::from_port(Box::new(slave)).expect("connect");
    (conn, device)
}

// --- scenarios ---

#[test]
fn full_command_sweep() {
    let (mut conn, _dev) = connect_mock(MockFw::new(), vec![]);

    // Device information
    let version = conn.version().unwrap();
    assert_eq!(
        (
            version.major,
            version.minor,
            version.patch,
            version.protocol_version
        ),
        (0, 1, 3, 2)
    );
    let caps = conn.caps().unwrap();
    assert_eq!(caps.dio, 25);
    assert_eq!(caps.ts_res_ns, 40);
    assert_eq!(caps.tick_ns, 200);
    assert!(caps.has_sync());
    let info = conn.info().unwrap();
    assert_eq!(info.uid, "AABBCCDD11223344");
    assert_eq!(info.device_number, Some(42));
    conn.set_device_number(7).unwrap();

    // Digital I/O
    assert_eq!(conn.read().unwrap(), 0x05);
    conn.write(0x0A, 0x0F).unwrap();
    let state = conn.state().unwrap();
    assert_eq!(state.inputs, 0x05);
    assert_eq!(state.outputs, 0x0A);

    // Pin map
    let map = conn.map_get().unwrap();
    assert_eq!(map, PinMap::default());
    let new_map = PinMap {
        direction: 0xff,
        pull_down: VALID_DIO_MASK & !0xff,
        edge: VALID_DIO_MASK & !0xff,
        out_default: 0x0f,
        ..PinMap::default()
    };
    conn.map_set(&new_map).unwrap();
    assert_eq!(conn.map_get().unwrap(), new_map);
    conn.map_save().unwrap();
    conn.map_default().unwrap();
    assert_eq!(conn.map_get().unwrap(), PinMap::default());

    // Pattern
    let steps = vec![
        PatternStep {
            out_bits: 0x0F,
            hold_ticks: 100,
        },
        PatternStep {
            out_bits: 0x00,
            hold_ticks: 100,
        },
    ];
    assert_eq!(conn.pattern_load(&steps).unwrap(), 2);
    conn.pattern_run(PatternMode::Loop, 10).unwrap();
    assert_eq!(conn.pattern_status().unwrap().state, PatternState::Running);
    conn.pattern_stop().unwrap();
    assert_eq!(conn.pattern_status().unwrap().state, PatternState::Loaded);

    // Timestamp (counted read)
    conn.ts_arm(0x07FF, EdgeMode::Both).unwrap();
    let result = conn.ts_get(256).unwrap();
    assert_eq!(result.events.len(), 2);
    assert_eq!(result.events[0].raw_count, 1000);
    assert_eq!(result.events[0].ns(40), 1_000_280);
    assert!(!result.reconciled);
    conn.ts_disarm().unwrap();

    // Sync (sync count is single-line: must not hang on a counted read)
    conn.sync_master().unwrap();
    conn.sync_start().unwrap();
    let start = Instant::now();
    assert_eq!(conn.sync_count().unwrap(), 1_000_000);
    assert!(start.elapsed() < Duration::from_secs(1));
    conn.sync_stop().unwrap();
    conn.sync_disarm().unwrap();

    // Raw escape hatch
    assert_eq!(conn.raw("version").unwrap(), "OK fw=0.1.3 proto=2");

    conn.close().unwrap();
}

#[test]
fn device_errors_are_typed() {
    let (mut conn, _dev) = connect_mock(MockFw::new(), vec![]);

    // ts get before arm
    assert!(matches!(conn.ts_get(10).unwrap_err(), SdkError::NotArmed));
    // sync count before start
    assert!(matches!(
        conn.sync_count().unwrap_err(),
        SdkError::SyncState
    ));
    // pattern run with nothing loaded
    assert!(matches!(
        conn.pattern_run(PatternMode::Once, 1).unwrap_err(),
        SdkError::BadParam
    ));
    // unknown command via raw goes through (raw never errors on ERR)
    assert_eq!(conn.raw("frobnicate").unwrap(), "ERR UNKNOWN_CMD");
    // an invalid map is refused host-side before anything is sent
    let bad_map = PinMap {
        pull_up: 0b1,
        pull_down: 0b1,
        ..PinMap::default()
    };
    assert!(matches!(
        conn.map_set(&bad_map).unwrap_err(),
        SdkError::InvalidArgument(_)
    ));
    // a map the device rejects surfaces as BAD_MAP (raw never errors on ERR)
    assert_eq!(conn.raw("map set flags=0x01").unwrap(), "ERR BAD_MAP");
    // pattern stop while idle now surfaces ErrNotRunning (FW v0.1.3+)
    assert!(matches!(
        conn.pattern_stop().unwrap_err(),
        SdkError::NotRunning
    ));
}

#[test]
fn pattern_reset_returns_engine_to_idle() {
    let (mut conn, _dev) = connect_mock(MockFw::new(), vec![]);
    let steps = [PatternStep {
        out_bits: 0x0F,
        hold_ticks: 100,
    }];
    conn.pattern_load(&steps).unwrap();
    conn.pattern_run(PatternMode::Loop, 1).unwrap();
    assert_eq!(conn.pattern_status().unwrap().state, PatternState::Running);

    conn.pattern_reset().unwrap();
    assert_eq!(conn.pattern_status().unwrap().state, PatternState::Idle);
    // After pattern reset the loaded buffer is gone — re-running is BAD_PARAM.
    assert!(matches!(
        conn.pattern_run(PatternMode::Once, 1).unwrap_err(),
        SdkError::BadParam
    ));
}

#[test]
fn system_reset_consumes_connection() {
    let (conn, _dev) = connect_mock(MockFw::new(), vec![]);
    conn.system_reset().unwrap();
    // The connection has been consumed — the type system enforces this.
}

#[test]
fn bootsel_reset_consumes_connection() {
    let (conn, _dev) = connect_mock(MockFw::new(), vec![]);
    conn.bootsel_reset().unwrap();
}

#[test]
fn push_events_interleaved_with_commands() {
    // Each command response is preceded by an INPUT push: responses must
    // still parse and pushes must reach the event channel.
    let (mut conn, _dev) = connect_mock(
        MockFw::new(),
        vec!["! INPUT in=0x00000001 t=100", "! PATTERN_DONE loops=2"],
    );
    let events = conn.subscribe_events();
    conn.subscribe(true).unwrap();
    assert_eq!(conn.read().unwrap(), 0x05);

    let timeout = Duration::from_secs(1);
    let mut seen_input = 0;
    let mut seen_pattern = 0;
    for _ in 0..4 {
        match events.recv_timeout(timeout).unwrap() {
            PushEvent::InputChange {
                inputs: 1,
                t_us: 100,
            } => seen_input += 1,
            PushEvent::PatternDone { loops: 2 } => seen_pattern += 1,
            other => panic!("unexpected event: {other:?}"),
        }
    }
    assert_eq!(seen_input, 2);
    assert_eq!(seen_pattern, 2);
}

#[test]
fn pre_v2_firmware_fails_loudly() {
    let mut fw = MockFw::new();
    fw.old_firmware = true;
    let (mut conn, _dev) = connect_mock(fw, vec![]);

    // v1 `caps` (ts_res=1000ns, no tick_ns) is not v2 and must not parse.
    assert!(matches!(conn.caps().unwrap_err(), SdkError::Parse(_)));

    // v1 `ts get` header has no overflow= and its lines use `t=`.
    conn.ts_arm(0x01, EdgeMode::Rising).unwrap();
    assert!(matches!(conn.ts_get(10).unwrap_err(), SdkError::Parse(_)));
}

#[test]
fn timeout_then_recovery() {
    // A command the mock never answers (it answers everything, so simulate
    // by stopping the mock), then verify Timeout surfaces.
    let (master, slave) = TTYPort::pair().expect("PTY pair");
    let mut conn = Connection::from_port(Box::new(slave)).expect("connect");
    conn.set_timeout(Duration::from_millis(200));
    let err = conn.version().unwrap_err();
    assert!(matches!(err, SdkError::Timeout));

    // The same connection recovers once the device starts answering.
    let _dev = MockDevice::spawn(master, MockFw::new(), vec![]);
    let version = conn.version().unwrap();
    assert_eq!(version.minor, 1);
}

#[test]
fn ts_get_empty_ring() {
    let mut fw = MockFw::new();
    fw.ts_events = vec![];
    let (mut conn, _dev) = connect_mock(fw, vec![]);
    conn.ts_arm(0x01, EdgeMode::Rising).unwrap();
    let result = conn.ts_get(256).unwrap();
    assert!(result.events.is_empty());
    assert!(!result.overflow);
    // The connection is still usable right away (no stray lines pending).
    assert_eq!(conn.read().unwrap(), 0x05);
}

#[test]
fn ts_get_overflow_flag_propagates() {
    // FW reported ring overflow since the last get; SDK must surface it.
    let mut fw = MockFw::new();
    fw.ts_overflow = true;
    let (mut conn, _dev) = connect_mock(fw, vec![]);
    conn.ts_arm(0x0F, EdgeMode::Rising).unwrap();
    let result = conn.ts_get(256).unwrap();
    assert!(result.overflow);
    assert_eq!(result.events.len(), 2);
}

#[test]
fn reconcile_pipeline_from_ts_get() {
    // ts_get → SourceEvent conversion → group_events, end to end.
    let mut fw = MockFw::new();
    // Straddle case: one channel latched count after the µs edge (c=1001)
    // while the other latched before (c=1000) at the same phase. Naive ns
    // values differ by 1000ns; reconcile recovers the shared instant.
    fw.ts_events = vec![
        "  in=0x00000001 c=1001 p=2 s=1",
        "  in=0x00000003 c=1000 p=2 s=1",
    ];
    let (mut conn, _dev) = connect_mock(fw, vec![]);
    conn.ts_arm(0x03, EdgeMode::Rising).unwrap();
    let result = conn.ts_get(256).unwrap();

    let source_events: Vec<pochi_sdk::reconcile::SourceEvent> = result
        .events
        .iter()
        .map(|ev| pochi_sdk::reconcile::SourceEvent {
            device: "local".to_string(),
            channel: format!("GP{}", ev.inputs.trailing_zeros()),
            inputs: format!("0x{:08X}", ev.inputs),
            raw_count: ev.raw_count,
            raw_phase: ev.raw_phase,
            sync_active: ev.sync_active,
        })
        .collect();
    let groups = pochi_sdk::reconcile::group_events(&source_events);
    assert_eq!(groups.len(), 1);
    assert!(groups[0].reconciled);
    // Straddle corrected: naive values were 1000ns apart, reconcile picks
    // a zero-diff combination. (Which µs the pair lands on is a tie and
    // depends on enumeration order, so assert the diff, not the absolute.)
    assert_eq!(groups[0].reconciled_ns[0], groups[0].reconciled_ns[1]);
}
