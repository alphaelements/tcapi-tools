//! Hardware smoke tests — require a connected Pochi-DIO device.
//!
//! Ignored by default (CI has no hardware). Run explicitly with:
//!
//! ```sh
//! cargo test -p pochi-sdk --test hw_smoke -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! `--test-threads=1` is required: the tests share one physical device.
//! The tests restore the device pin map and device number on completion.
//!
//! Edge-capture and push-event delivery need an external signal source.
//! If the persisted pin map is `out=0:>=4 in=4:>=4` (the loopback rig —
//! GP0..GP3 wired to GP4..GP7) the smoke runs a full stimulus → capture
//! → subscribe push pass. Otherwise those steps verify only the
//! protocol flow (count=0 counted read, subscribe on/off).
//!
//! When several Pochi-DIOs are connected, set `POCHI_SMOKE_UID=<UID>`
//! to pick a specific one (e.g. the loopback rig). Default: first in
//! port order.

use pochi_sdk::{
    discover, discover_detailed, Connection, EdgeMode, PatternMode, PatternState, PatternStep,
    PushEvent,
};

#[test]
#[ignore = "requires connected Pochi-DIO hardware"]
fn hw_discovery() {
    let detailed = discover_detailed().expect("discovery failed");
    assert!(
        detailed.failures.is_empty(),
        "probe failures: {:?}",
        detailed.failures
    );
    let devices = detailed.devices;
    assert!(!devices.is_empty(), "no Pochi-DIO found");
    println!("discovered: {devices:?}");

    // A Debugprobe (2e8a:000c) on the same host must NOT be detected. Its
    // tty number depends on plug order, so locate it by USB descriptor
    // instead of hard-coding a port name.
    let debugprobe_ports: Vec<String> = serialport::available_ports()
        .expect("port enumeration failed")
        .into_iter()
        .filter_map(|p| match p.port_type {
            serialport::SerialPortType::UsbPort(usb) if usb.vid == 0x2E8A && usb.pid == 0x000C => {
                Some(p.port_name)
            }
            _ => None,
        })
        .collect();
    println!("debugprobe ports: {debugprobe_ports:?}");
    assert!(
        devices.iter().all(|d| !debugprobe_ports.contains(&d.port)),
        "Debugprobe misdetected as Pochi-DIO"
    );
    for dev in &devices {
        assert_eq!(dev.uid.len(), 16, "UID must be 16 hex chars: {}", dev.uid);
        assert!(dev.version.is_some(), "version probe failed");
    }
}

#[test]
#[ignore = "requires connected Pochi-DIO hardware"]
fn hw_full_smoke() {
    let devices = discover().expect("discovery failed");
    // Pick a specific device by UID via POCHI_SMOKE_UID when several
    // Pochi-DIOs are connected (e.g. the loopback rig vs. spare units).
    let device = match std::env::var("POCHI_SMOKE_UID") {
        Ok(uid) if !uid.is_empty() => devices
            .iter()
            .find(|d| d.uid.eq_ignore_ascii_case(&uid))
            .unwrap_or_else(|| panic!("POCHI_SMOKE_UID={uid} not in discovered: {devices:?}")),
        _ => devices.first().expect("no Pochi-DIO found"),
    };
    println!("using {} (uid={})", device.port, device.uid);

    let mut conn = Connection::open(&device.port).expect("connect failed");

    // --- info layer ---
    let version = conn.version().expect("version");
    println!(
        "version: v{}.{}.{} proto={}",
        version.major, version.minor, version.patch, version.protocol_version
    );
    let caps = conn.caps().expect("caps");
    println!("caps: {caps:?}");
    assert_eq!(caps.max_dio, 23);
    assert_ne!(caps.ts_resolution_ns, 1000, "old firmware");
    let info = conn.info().expect("info");
    assert_eq!(info.uid, device.uid);

    // connect_by_uid round-trip
    drop(conn);
    let mut conn = Connection::open_by_uid(&device.uid).expect("open_by_uid");

    // --- save original state for restoration ---
    let original_map = conn.map_get().expect("map get");
    println!("original map: {original_map:?}");
    let original_devnum = info.device_number;

    // --- loopback edge capture + subscribe push (rig: GP0..3 → GP4..7) ---
    // Only when the persisted map matches the rig wiring. Other devices
    // (no loopback wire) skip this block — `hw_full_smoke` is intended to
    // pass on any healthy Pochi-DIO.
    let loopback_rig = original_map.out_base == 0
        && original_map.out_count >= 4
        && original_map.in_base == 4
        && original_map.in_count >= 4;
    if loopback_rig {
        run_loopback_edge_capture(&mut conn);
    } else {
        println!(
            "skipping loopback edge capture (map is {}:{}/{}:{}, expected 0:>=4/4:>=4)",
            original_map.out_base,
            original_map.out_count,
            original_map.in_base,
            original_map.in_count,
        );
    }

    // --- devnum ---
    conn.set_device_number(7).expect("devnum set");
    assert_eq!(conn.info().expect("info").device_number, Some(7));
    conn.set_device_number(original_devnum.unwrap_or(255))
        .expect("devnum restore");

    // --- pin map: 12 out / 11 in ---
    let work_map = pochi_sdk::PinMap {
        version: 1,
        out_base: 0,
        out_count: 12,
        in_base: 12,
        in_count: 11,
        pull: pochi_sdk::PullMode::Up,
        flags: 0x01,
    };
    conn.map_set(&work_map).expect("map set");
    let active = conn.map_get().expect("map get after set");
    assert_eq!(active.out_count, 12);
    assert_eq!(active.in_count, 11);

    // --- write / read / state ---
    conn.write(0x0A5, 0xFFF).expect("write");
    let state = conn.state().expect("state");
    println!("state after write 0x0A5: {state:?}");
    assert_eq!(state.outputs & 0xFFF, 0x0A5);
    let inputs = conn.read().expect("read");
    println!("inputs: {inputs:#x}");
    conn.write(0, 0xFFF).expect("write clear");
    assert_eq!(conn.state().expect("state").outputs & 0xFFF, 0);

    // --- pattern: once + loop ---
    let steps = vec![
        PatternStep {
            out_bits: 0x00F,
            hold_us: 1000,
        },
        PatternStep {
            out_bits: 0x000,
            hold_us: 1000,
        },
        PatternStep {
            out_bits: 0x0F0,
            hold_us: 1000,
        },
        PatternStep {
            out_bits: 0x000,
            hold_us: 1000,
        },
    ];
    let accepted = conn.pattern_load(&steps).expect("pattern load");
    assert_eq!(accepted, 4);

    conn.pattern_run(PatternMode::Once, 1)
        .expect("pattern run once");
    std::thread::sleep(std::time::Duration::from_millis(50));
    let status = conn.pattern_status().expect("pattern status");
    println!("pattern status after once: {status:?}");
    assert_ne!(
        status.state,
        PatternState::Running,
        "4ms pattern still running"
    );

    // repeat=0 is rejected by FW (BAD_PARAM) — there is no infinite mode;
    // 1000 loops x 4ms is long enough to observe Running and stop it.
    conn.pattern_run(PatternMode::Loop, 1000)
        .expect("pattern run loop");
    std::thread::sleep(std::time::Duration::from_millis(20));
    let status = conn.pattern_status().expect("pattern status");
    assert_eq!(status.state, PatternState::Running);
    conn.pattern_stop().expect("pattern stop");
    let status = conn.pattern_status().expect("pattern status");
    assert_ne!(status.state, PatternState::Running);

    // --- timestamp: arm / get / disarm (counted read, incl. count=0) ---
    conn.ts_arm(0x07FF, EdgeMode::Both).expect("ts arm");
    let result = conn.ts_get(256).expect("ts get");
    println!(
        "ts events without stimulus: {} (expected 0 unless inputs are wired)",
        result.events.len()
    );
    for ev in &result.events {
        println!("  {ev:?}");
    }
    conn.ts_disarm().expect("ts disarm");

    // The connection must still be healthy right after a counted read.
    let _ = conn.read().expect("read after ts get");

    // --- subscribe on/off + event channel plumbed ---
    let _events = conn.subscribe_events();
    conn.subscribe(true).expect("subscribe on");
    conn.subscribe(false).expect("subscribe off");

    // --- sync (single device): arm/disarm cycle + count is single-line ---
    conn.sync_master().expect("sync master");
    conn.sync_start().expect("sync start");
    let count1 = conn.sync_count().expect("sync count");
    std::thread::sleep(std::time::Duration::from_millis(10));
    let count2 = conn.sync_count().expect("sync count 2");
    println!("sync counts: {count1} -> {count2}");
    assert!(count2 > count1, "sync clock not advancing");
    conn.sync_stop().expect("sync stop");
    conn.sync_disarm().expect("sync disarm");

    // --- raw escape hatch ---
    let raw = conn.raw("version").expect("raw");
    assert!(raw.starts_with("OK "), "raw response: {raw}");

    // --- restore original map and persist ---
    conn.map_set(&original_map).expect("map restore");
    conn.map_save().expect("map save");
    let restored = conn.map_get().expect("map get final");
    assert_eq!(restored.out_count, original_map.out_count);
    assert_eq!(restored.in_count, original_map.in_count);

    conn.close().expect("close");
    println!("hw_full_smoke: all steps passed");
}

/// Drive 4 rising edges through the GP0..3 → GP4..7 loopback, capture
/// them with `ts get`, then re-run the pattern with `subscribe on` and
/// assert push events arrive. The persisted map must be `out=0:>=4
/// in=4:>=4` (the loopback rig wiring); the caller checks that.
///
/// FW behaviour the assertions rely on (FW v0.1.2 commit `928b66e` and
/// later):
/// - `EdgeMode::Rising` filters out falling edges — the trailing F→0
///   transition after the pattern ends is excluded from the stream,
/// - `arm` injects one synthetic baseline event so the first real edge
///   is not eaten by the engine, and the IN_COUNT hard mask keeps
///   unrelated GPIO bits out of the stream.
///
/// Observed quirk: pattern engine takeover can cause the GP0..3 outputs
/// to jump 0→0xF for one cycle at pattern start, which makes the first
/// step value (0x1) invisible to a rising-edge filter on some runs.
/// The assertions therefore require the *trailing* 3 step values
/// `[0x3, 0x7, 0xF]` to appear contiguously (always present), but
/// tolerate the leading `0x1` being absent.
fn run_loopback_edge_capture(conn: &mut Connection) {
    // Clean slate: clear outputs and let inputs settle before arming,
    // so residual state from prior tests does not contaminate the ring.
    // Also force-stop a possibly running pattern and turn off subscribe,
    // in case a previous test run was aborted mid-flight and the device
    // is still in `state=running step=0 loops=0` or pushing events.
    let _ = conn.subscribe(false);
    let _ = conn.pattern_stop();
    let _ = conn.ts_disarm();
    conn.write(0, 0xF).expect("write clear before arm");
    std::thread::sleep(std::time::Duration::from_millis(20));

    // Accumulating walk on GP0..GP3 → four rising edges, monitored via
    // GP4..GP7 through the loopback wire.
    const HOLD_US: u32 = 200;
    const EXPECTED_TAIL: [u32; 4] = [0x1, 0x3, 0x7, 0xF];
    let steps = EXPECTED_TAIL
        .iter()
        .map(|&v| PatternStep {
            out_bits: v,
            hold_us: HOLD_US,
        })
        .collect::<Vec<_>>();
    let accepted = conn.pattern_load(&steps).expect("pattern load loopback");
    assert_eq!(accepted, 4);

    // --- Pass 1: ts arm rising → run → ts get → strict tail check ---
    conn.ts_arm(0xF, EdgeMode::Rising).expect("ts arm rising");
    conn.pattern_run(PatternMode::Once, 1)
        .expect("pattern run for ts");
    wait_pattern_idle(conn, "ts loopback");

    // FW v0.1.2 max-events-per-response is 85, well above our worst case.
    let result = conn.ts_get(16).expect("ts get loopback");
    assert!(
        !result.overflow,
        "ring overflow not expected for ≤16 events: {result:?}"
    );
    let edges = &result.events;
    println!("loopback ts events ({}):", edges.len());
    for (i, e) in edges.iter().enumerate() {
        println!(
            "  [{i}] inputs=0x{:X} ts_ns={}",
            e.inputs & 0xF,
            e.timestamp_ns
        );
    }

    // The pattern walk produces up to 4 rising edges (0x1, 0x3, 0x7,
    // 0xF). The leading 0x1 may be lost when the pattern engine takes
    // over the pins with outputs already at 0x0 (see fn doc); the last
    // three steps [0x3, 0x7, 0xF] are always observable and must appear
    // as a contiguous trailing subsequence.
    let nibbles: Vec<u32> = edges.iter().map(|e| e.inputs & 0xF).collect();
    let expected_tail: &[u32] = &EXPECTED_TAIL[1..]; // [0x3, 0x7, 0xF]
    assert!(
        nibbles.len() >= expected_tail.len(),
        "expected at least {} events, got {}: {nibbles:?}",
        expected_tail.len(),
        nibbles.len()
    );
    let tail = &nibbles[nibbles.len() - expected_tail.len()..];
    assert_eq!(
        tail, expected_tail,
        "expected trailing subsequence {expected_tail:?}, got {tail:?} (full sequence: {nibbles:?})"
    );
    // Rising-only mode must not include the trailing F→0 falling edge.
    let last = *nibbles.last().expect("non-empty events");
    assert_eq!(
        last, 0xF,
        "rising mode should end on 0xF, got 0x{last:X} — falling edge leaked through filter"
    );
    // Every nibble must be one of the legitimate pattern values, no
    // stray bits — verifies the IN_COUNT hard mask is in effect.
    for n in &nibbles {
        assert!(
            matches!(*n, 0x0 | 0x1 | 0x3 | 0x7 | 0xF),
            "unexpected nibble 0x{n:X} in stream: {nibbles:?}"
        );
    }
    let ns: Vec<i64> = edges.iter().map(|e| e.timestamp_ns).collect();
    for w in ns.windows(2) {
        assert!(w[1] > w[0], "ts not monotonic: {ns:?}");
    }

    // Hold timing assertion: the trailing tail [0x3, 0x7, 0xF] is always
    // present, so the span between its first and last edges should equal
    // `(tail.len() - 1) * HOLD_US`. A regression where the FW completes
    // the pattern before honoring the last hold (the v0.1.2 problem A bug
    // fixed in pochi-dio commit ae2af10) would make the span much shorter,
    // so a generous ±50 µs/step tolerance still catches it.
    let tail_ns = &ns[ns.len() - expected_tail.len()..];
    let span_us = ((tail_ns[tail_ns.len() - 1] - tail_ns[0]) / 1000) as u64;
    let expected_us = (expected_tail.len() as u64 - 1) * HOLD_US as u64;
    let tolerance_us = expected_tail.len() as u64 * 50;
    assert!(
        span_us.abs_diff(expected_us) < tolerance_us,
        "hold timing drift: expected {expected_us}us got {span_us}us (tail ns={tail_ns:?})"
    );

    conn.ts_disarm().expect("ts disarm loopback");

    // --- Pass 2: subscribe on → run → assert ≥1 InputChange push ---
    let events_rx = conn.subscribe_events();
    while events_rx.try_recv().is_ok() {} // drain leftover pushes
    conn.write(0, 0xF).expect("write clear before subscribe");
    std::thread::sleep(std::time::Duration::from_millis(20));
    conn.subscribe(true).expect("subscribe on");
    conn.pattern_run(PatternMode::Once, 1)
        .expect("pattern run for subscribe");
    wait_pattern_idle(conn, "subscribe loopback");

    let mut input_pushes = 0usize;
    let mut pattern_done_seen = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    while std::time::Instant::now() < deadline {
        match events_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(PushEvent::InputChange { inputs, .. }) => {
                println!("  push InputChange inputs=0x{inputs:x}");
                input_pushes += 1;
            }
            Ok(PushEvent::PatternDone { loops }) => {
                println!("  push PatternDone loops={loops}");
                pattern_done_seen = true;
            }
            Ok(other) => println!("  push other: {other:?}"),
            Err(_) => break,
        }
    }
    conn.subscribe(false).expect("subscribe off");
    println!("loopback subscribe: input pushes={input_pushes}, pattern_done={pattern_done_seen}");
    assert!(
        input_pushes >= 1,
        "no ! INPUT push received during loopback pattern"
    );

    conn.write(0, 0xF).expect("write clear after loopback");
}

fn wait_pattern_idle(conn: &mut Connection, label: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    loop {
        let status = conn.pattern_status().expect("pattern status");
        if status.state != PatternState::Running {
            return;
        }
        if std::time::Instant::now() >= deadline {
            panic!("{label}: pattern still running after 500ms ({status:?})");
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
