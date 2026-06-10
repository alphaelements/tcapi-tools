//! End-to-end tests against a mock firmware running on a PTY.
//!
//! The mock implements the FW Phase 9.6 text command set with enough state
//! (outputs, pin map, pattern, ts ring, sync, subscription) to exercise the
//! full `Connection` API including counted reads, push event multiplexing,
//! device errors, and old-firmware rejection.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use pochi_sdk::{
    Connection, EdgeMode, PatternMode, PatternState, PatternStep, PullMode, PushEvent, SdkError,
};
use serialport::{SerialPort, TTYPort};

/// Mock device state.
struct MockFw {
    outputs: u32,
    inputs: u32,
    map: String, // raw `map get` data
    subscribed: bool,
    pattern_loaded: u16,
    pattern_state: &'static str,
    ts_armed: bool,
    ts_events: Vec<&'static str>,
    sync_clocking: bool,
    /// Reply with the pre-Phase 9.6 formats.
    old_firmware: bool,
}

impl MockFw {
    fn new() -> Self {
        Self {
            outputs: 0,
            inputs: 0x05,
            map: "v=1 out=0:12 in=12:11 pull=up flags=0x01".to_string(),
            subscribed: false,
            pattern_loaded: 0,
            pattern_state: "idle",
            ts_armed: false,
            ts_events: vec![
                "  0x00000005 c=1000 p=7 s=1",
                "  0x0000000A c=2000 p=12 s=0",
            ],
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
            ["version"] => vec!["OK v0.1.0 proto=1".into()],
            ["caps"] => {
                if self.old_firmware {
                    vec![
                        "OK dio=23 out=12 in=11 ts_res=1000ns pattern=256 ring=256 feat=0x00000001"
                            .into(),
                    ]
                } else {
                    vec![
                        "OK dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000001"
                            .into(),
                    ]
                }
            }
            ["info"] => vec!["OK uid=AABBCCDD11223344 devnum=42".into()],
            ["devnum", n] => match n.parse::<u16>() {
                Ok(0..=255) => vec!["OK".into()],
                _ => vec!["ERR BAD_PARAM".into()],
            },
            ["read"] => vec![format!("OK 0x{:06X}", self.inputs)],
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
                "OK in=0x{:06X} out=0x{:06X} flags=0x00",
                self.inputs, self.outputs
            )],
            ["map", "get"] => vec![format!("OK {}", self.map)],
            ["map", "set", hex] => {
                if hex.len() != 48 || hex::decode(hex).is_err() {
                    vec!["ERR BAD_PARAM".into()]
                } else {
                    let bytes = hex::decode(hex).unwrap();
                    if bytes[2] != 0 && bytes[4] != 0 {
                        let out_end = bytes[1] + bytes[2];
                        if bytes[3] < out_end && bytes[1] < bytes[3] + bytes[4] {
                            return vec!["ERR BAD_MAP".into()];
                        }
                    }
                    let pull = match bytes[5] {
                        0 => "none",
                        1 => "up",
                        _ => "down",
                    };
                    self.map = format!(
                        "v={} out={}:{} in={}:{} pull={} flags=0x{:02x}",
                        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], pull, bytes[6]
                    );
                    vec!["OK".into()]
                }
            }
            ["map", "save"] => vec!["OK".into()],
            ["map", "default"] => {
                self.map = "v=1 out=0:0 in=0:23 pull=down flags=0x01".to_string();
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
            ["pattern", "load", hex] => match hex::decode(hex) {
                Ok(bytes) if bytes.len() >= 10 => {
                    let count = u16::from_le_bytes([bytes[0], bytes[1]]);
                    if bytes.len() != 2 + count as usize * 8 {
                        return vec!["ERR BAD_PARAM".into()];
                    }
                    if count > 256 {
                        return vec!["ERR TOO_LONG".into()];
                    }
                    self.pattern_loaded = count;
                    self.pattern_state = "loaded";
                    vec![format!("OK accepted={count}")]
                }
                _ => vec!["ERR BAD_PARAM".into()],
            },
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
                if self.pattern_loaded > 0 {
                    self.pattern_state = "loaded";
                }
                vec!["OK".into()]
            }
            ["pattern", "status"] => {
                vec![format!("OK state={} step=0 loops=0", self.pattern_state)]
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
                    return vec!["OK count=1".into(), "  0x00000005 t=1234567890".into()];
                }
                let events: Vec<String> = self
                    .ts_events
                    .iter()
                    .take(max)
                    .map(|s| s.to_string())
                    .collect();
                let mut lines = vec![format!("OK count={}", events.len())];
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
                    // `OK count=N` with NO data lines (unlike `ts get`).
                    vec!["OK count=1000000".into()]
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
        (0, 1, 0, 1)
    );
    let caps = conn.caps().unwrap();
    assert_eq!(caps.max_dio, 23);
    assert_eq!(caps.ts_resolution_ns, 40);
    assert_eq!(caps.protocol_version, 1);
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
    assert_eq!(map.out_count, 12);
    assert_eq!(map.pull, PullMode::Up);
    let mut new_map = map.clone();
    new_map.out_count = 8;
    new_map.in_base = 8;
    new_map.in_count = 15;
    conn.map_set(&new_map).unwrap();
    let round_trip = conn.map_get().unwrap();
    assert_eq!(round_trip.out_count, 8);
    assert_eq!(round_trip.in_base, 8);
    conn.map_save().unwrap();
    conn.map_default().unwrap();
    assert_eq!(conn.map_get().unwrap().in_count, 23);

    // Pattern
    let steps = vec![
        PatternStep {
            out_bits: 0x0F,
            hold_us: 100,
        },
        PatternStep {
            out_bits: 0x00,
            hold_us: 100,
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
    assert_eq!(result.events[0].timestamp_ns, 1_000_280);
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
    assert_eq!(conn.raw("version").unwrap(), "OK v0.1.0 proto=1");

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
    // overlapping map rejected by device
    let bad_map = pochi_sdk::PinMap {
        version: 1,
        out_base: 0,
        out_count: 12,
        in_base: 4,
        in_count: 11,
        pull: PullMode::Up,
        flags: 0,
    };
    assert!(matches!(
        conn.map_set(&bad_map).unwrap_err(),
        SdkError::BadMap
    ));
}

#[test]
fn push_events_interleaved_with_commands() {
    // Each command response is preceded by an INPUT push: responses must
    // still parse and pushes must reach the event channel.
    let (mut conn, _dev) = connect_mock(
        MockFw::new(),
        vec!["! INPUT 0x000001 t=100", "! PATTERN_DONE loops=2"],
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
                timestamp_us: 100,
            } => seen_input += 1,
            PushEvent::PatternDone { loops: 2 } => seen_pattern += 1,
            other => panic!("unexpected event: {other:?}"),
        }
    }
    assert_eq!(seen_input, 2);
    assert_eq!(seen_pattern, 2);
}

#[test]
fn old_firmware_fails_loudly() {
    let mut fw = MockFw::new();
    fw.old_firmware = true;
    let (mut conn, _dev) = connect_mock(fw, vec![]);

    // caps reports ts_res=1000 → UnsupportedFirmware
    assert!(matches!(
        conn.caps().unwrap_err(),
        SdkError::UnsupportedFirmware(_)
    ));

    // ts get returns the old `t=` line format → UnsupportedFirmware
    conn.ts_arm(0x01, EdgeMode::Rising).unwrap();
    assert!(matches!(
        conn.ts_get(10).unwrap_err(),
        SdkError::UnsupportedFirmware(_)
    ));
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
    // The connection is still usable right away (no stray lines pending).
    assert_eq!(conn.read().unwrap(), 0x05);
}

#[test]
fn reconcile_pipeline_from_ts_get() {
    // ts_get → SourceEvent conversion → group_events, end to end.
    let mut fw = MockFw::new();
    // Straddle case: one channel latched count after the µs edge (c=1001)
    // while the other latched before (c=1000) at the same phase. Naive ns
    // values differ by 1000ns; reconcile recovers the shared instant.
    fw.ts_events = vec!["  0x00000001 c=1001 p=2 s=1", "  0x00000003 c=1000 p=2 s=1"];
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
