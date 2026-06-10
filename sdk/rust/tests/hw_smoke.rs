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
//! Edge-capture and push-event delivery need an external signal source on
//! an input pin; without one those paths verify the protocol flow only
//! (count=0 counted read, subscribe on/off).

use pochi_sdk::{
    discover, discover_detailed, Connection, EdgeMode, PatternMode, PatternState, PatternStep,
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

    // The Debugprobe (2e8a:000c) on the same host must NOT be detected.
    assert!(
        devices.iter().all(|d| !d.port.contains("ttyACM2")),
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
    let device = devices.first().expect("no Pochi-DIO found");
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
