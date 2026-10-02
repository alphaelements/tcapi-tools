//! Transport contract tests (R-H1 .. R-H4, R-E2) against the in-memory
//! fake device. No PTY involved.

use super::*;
use crate::testutil::{pong_for, FakeDevice};
use assert_matches::assert_matches;
use std::thread::JoinHandle;

const SHORT_TIMEOUT: Duration = Duration::from_millis(150);
const WAIT: Duration = Duration::from_secs(2);

fn lines(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

/// Transport wired to a fake device running `handler`.
fn transport_with(
    handler: impl FnMut(&str) -> Vec<String> + Send + 'static,
) -> (Transport, FakeDevice) {
    let (reader, writer, device) = FakeDevice::spawn(handler);
    let mut transport = Transport::from_io(Box::new(reader), Box::new(writer));
    transport.set_timeout(SHORT_TIMEOUT);
    (transport, device)
}

/// Device that answers `ping` and a few fixed commands, nothing else.
fn basic_device(cmd: &str) -> Vec<String> {
    if let Some(pong) = pong_for(cmd) {
        return pong;
    }
    match cmd {
        "version" => lines(&["OK fw=0.1.3 proto=2"]),
        "read" => lines(&["OK in=0x00000001"]),
        "subscribe on" | "subscribe off" => lines(&["OK"]),
        _ => lines(&["ERR UNKNOWN_CMD"]),
    }
}

fn wait_until(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Assert `cmds[at]` is a `ping <u32>` line and return the nonce.
fn ping_nonce(cmds: &[String], at: usize) -> u32 {
    cmds[at]
        .strip_prefix("ping ")
        .unwrap_or_else(|| panic!("command {at} is not a ping: {cmds:?}"))
        .parse()
        .expect("ping argument is a u32")
}

// --- R-H1: one command, one response ---

#[test]
fn command_ok() {
    let (mut t, dev) = transport_with(basic_device);
    assert_eq!(t.command("version").unwrap(), "fw=0.1.3 proto=2");
    assert_eq!(dev.commands(), ["version"]);
}

#[test]
fn command_device_error_is_typed_and_keeps_sync() {
    let (mut t, dev) = transport_with(basic_device);
    assert_matches!(t.command("bogus"), Err(SdkError::BadCommand));
    // A well-formed ERR is a complete response: no resync before the next
    // command.
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
    assert_eq!(dev.commands(), ["bogus", "read"]);
}

#[test]
fn sync_count_style_single_line_returns_without_waiting() {
    let (mut t, _dev) = transport_with(|c| match c {
        "sync count" => lines(&["OK clocks=1000000"]),
        _ => vec![],
    });
    let start = Instant::now();
    assert_eq!(t.command("sync count").unwrap(), "clocks=1000000");
    assert!(start.elapsed() < SHORT_TIMEOUT);
}

#[test]
fn counted_read_consumes_exactly_n_lines_and_stays_in_sync() {
    let (mut t, dev) = transport_with(|c| match c {
        "ts get 85" => lines(&[
            "OK count=2 overflow=0",
            "  in=0x00000005 c=1000 p=7 s=1",
            "  in=0x0000000a c=2000 p=12 s=0",
        ]),
        other => basic_device(other),
    });
    let (data, body) = t.command_counted("ts get 85").unwrap();
    assert_eq!(data, "count=2 overflow=0");
    assert_eq!(
        body,
        [
            "  in=0x00000005 c=1000 p=7 s=1",
            "  in=0x0000000a c=2000 p=12 s=0"
        ]
    );
    // Exactly N lines were consumed: the next command needs no resync.
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
    assert_eq!(dev.commands(), ["ts get 85", "read"]);
}

#[test]
fn counted_read_zero_count_reads_no_extra_lines() {
    let (mut t, _dev) = transport_with(|_| lines(&["OK count=0 overflow=0"]));
    let (data, body) = t.command_counted("ts get 85").unwrap();
    assert_eq!(data, "count=0 overflow=0");
    assert!(body.is_empty());
}

#[test]
fn counted_read_err_header_is_typed() {
    let (mut t, _dev) = transport_with(|_| lines(&["ERR NOT_ARMED"]));
    assert_matches!(t.command_counted("ts get 85"), Err(SdkError::NotArmed));
}

#[test]
fn counted_read_without_count_field_is_parse_error() {
    let (mut t, _dev) = transport_with(|_| lines(&["OK in=0x00000001"]));
    assert_matches!(t.command_counted("read"), Err(SdkError::Parse(_)));
}

#[test]
fn plain_command_rejects_a_counted_response_but_consumes_it() {
    let (mut t, dev) = transport_with(|c| match c {
        "help" => lines(&["OK count=1", "  help  Show this help"]),
        other => basic_device(other),
    });
    assert_matches!(t.command("help"), Err(SdkError::Parse(_)));
    // The continuation line was consumed, so the stream is still in step.
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
    assert_eq!(dev.commands(), ["help", "read"]);
}

#[test]
fn absurd_count_is_rejected_and_desyncs() {
    let (mut t, dev) = transport_with(|c| match c {
        "ts get 85" => lines(&["OK count=4294967295 overflow=0"]),
        other => basic_device(other),
    });
    assert_matches!(t.command_counted("ts get 85"), Err(SdkError::Parse(_)));
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
    let cmds = dev.commands();
    assert_eq!(cmds.len(), 3, "{cmds:?}");
    ping_nonce(&cmds, 1);
}

// --- R-H2: desync -> ping resync ---

#[test]
fn timeout_desyncs_then_ping_resyncs_and_discards_stale_line() {
    let mut silent = true;
    let (mut t, dev) = transport_with(move |c| {
        if c == "version" && silent {
            silent = false;
            return vec![]; // the command that times out
        }
        basic_device(c)
    });
    assert_matches!(t.command("version"), Err(SdkError::Timeout));

    // The late answer of the timed-out command arrives now.
    dev.inject("OK fw=0.0.0 proto=1");
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");

    let cmds = dev.commands();
    assert_eq!(cmds.len(), 3, "{cmds:?}");
    assert_eq!(cmds[0], "version");
    ping_nonce(&cmds, 1);
    assert_eq!(cmds[2], "read");
}

#[test]
fn resync_discards_pongs_with_a_different_value() {
    let mut silent = true;
    let (mut t, _dev) = transport_with(move |c| {
        if c == "version" && silent {
            silent = false;
            return vec![];
        }
        if let Some(n) = c.strip_prefix("ping ") {
            let other = n.parse::<u32>().unwrap().wrapping_add(1);
            // A stale pong of an older resync first, then the real one.
            return vec![format!("OK pong={other}"), format!("OK pong={n}")];
        }
        basic_device(c)
    });
    assert_matches!(t.command("version"), Err(SdkError::Timeout));
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
}

#[test]
fn unparseable_line_desyncs() {
    let mut garbage = true;
    let (mut t, dev) = transport_with(move |c| {
        if c == "version" && garbage {
            garbage = false;
            return lines(&["WHAT IS THIS"]);
        }
        basic_device(c)
    });
    assert_matches!(t.command("version"), Err(SdkError::Parse(_)));
    assert_eq!(t.command("version").unwrap(), "fw=0.1.3 proto=2");
    let cmds = dev.commands();
    assert_eq!(cmds.len(), 3, "{cmds:?}");
    ping_nonce(&cmds, 1);
}

#[test]
fn short_counted_response_desyncs_and_late_line_is_not_misassigned() {
    let mut short = true;
    let (mut t, dev) = transport_with(move |c| {
        if c == "ts get 85" && short {
            short = false;
            // Header announces 3 lines, only 2 are sent.
            return lines(&[
                "OK count=3 overflow=0",
                "  in=0x00000001 c=1 p=1 s=1",
                "  in=0x00000001 c=2 p=1 s=1",
            ]);
        }
        basic_device(c)
    });
    assert_matches!(t.command_counted("ts get 85"), Err(SdkError::Timeout));

    // The third line shows up late. It must never become the answer to the
    // next command.
    dev.inject("  in=0x00000001 c=3 p=1 s=1");
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
    let cmds = dev.commands();
    assert_eq!(cmds.len(), 3, "{cmds:?}");
    ping_nonce(&cmds, 1);
    assert_eq!(cmds[2], "read");
}

#[test]
fn failed_resync_closes_the_connection() {
    // Never answers anything, including ping.
    let (mut t, dev) = transport_with(|_| vec![]);
    assert_matches!(t.command("version"), Err(SdkError::Timeout));
    // Resync fails: the connection is closed.
    assert_matches!(t.command("read"), Err(SdkError::Disconnected));
    assert_matches!(t.command("read"), Err(SdkError::Disconnected));
    // version, one ping; nothing was sent after the connection closed.
    let cmds = dev.commands();
    assert_eq!(cmds.len(), 2, "{cmds:?}");
    ping_nonce(&cmds, 1);
}

#[test]
fn resync_nonce_is_a_fresh_u32_each_time() {
    let mut silent_budget = 2;
    let (mut t, dev) = transport_with(move |c| {
        if c == "version" && silent_budget > 0 {
            silent_budget -= 1;
            return vec![];
        }
        basic_device(c)
    });
    assert_matches!(t.command("version"), Err(SdkError::Timeout));
    t.command("read").unwrap(); // resync #1
    assert_matches!(t.command("version"), Err(SdkError::Timeout));
    t.command("read").unwrap(); // resync #2
    let cmds = dev.commands();
    let first = ping_nonce(&cmds, 1);
    let second = ping_nonce(&cmds, 4);
    assert_ne!(first, second);
}

// --- R-H3: raw ---

#[test]
fn raw_returns_a_single_line_unparsed() {
    let (mut t, _dev) = transport_with(basic_device);
    assert_eq!(t.raw("version").unwrap(), ["OK fw=0.1.3 proto=2"]);
}

#[test]
fn raw_returns_err_line_instead_of_failing() {
    let (mut t, _dev) = transport_with(basic_device);
    assert_eq!(t.raw("frobnicate").unwrap(), ["ERR UNKNOWN_CMD"]);
}

#[test]
fn raw_returns_every_line_of_a_counted_response() {
    let (mut t, dev) = transport_with(|c| match c {
        "help" => lines(&[
            "OK count=2",
            "  version  Get firmware version",
            "  help  Help",
        ]),
        other => basic_device(other),
    });
    assert_eq!(
        t.raw("help").unwrap(),
        [
            "OK count=2",
            "  version  Get firmware version",
            "  help  Help"
        ]
    );
    // Nothing left behind: the next command is in step without resync.
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
    assert_eq!(dev.commands(), ["help", "read"]);
}

#[test]
fn raw_rejects_subscribe_locally() {
    let (mut t, dev) = transport_with(basic_device);
    for cmd in [
        "subscribe on",
        "subscribe off",
        "SUBSCRIBE on",
        "  subscribe on",
        "subscribe",
    ] {
        assert_matches!(t.raw(cmd), Err(SdkError::InvalidArgument(_)), "{cmd:?}");
    }
    assert!(dev.commands().is_empty(), "nothing may reach the device");
}

#[test]
fn raw_does_not_reject_commands_that_merely_start_with_subscribe() {
    let (mut t, _dev) = transport_with(basic_device);
    assert_eq!(t.raw("subscribed").unwrap(), ["ERR UNKNOWN_CMD"]);
}

#[test]
fn raw_rejects_overlong_line_and_embedded_line_breaks() {
    let (mut t, dev) = transport_with(basic_device);
    let ok_line = format!("x{}", "a".repeat(protocol::MAX_LINE_BYTES - 1));
    assert_eq!(ok_line.len(), protocol::MAX_LINE_BYTES);
    assert_eq!(t.raw(&ok_line).unwrap(), ["ERR UNKNOWN_CMD"]);

    let too_long = format!("{ok_line}a");
    assert_matches!(t.raw(&too_long), Err(SdkError::InvalidArgument(_)));
    assert_matches!(t.raw("read\nwrite 1 1"), Err(SdkError::InvalidArgument(_)));
    assert_matches!(t.raw("read\rwrite 1 1"), Err(SdkError::InvalidArgument(_)));
    assert_eq!(dev.commands(), [ok_line]);
}

// --- R-H4: SDK-owned subscription, one device subscription, fan-out ---

#[test]
fn subscribe_is_reference_counted_and_fans_out() {
    let (mut t, dev) = transport_with(basic_device);
    let rx1 = t.subscribe_events().unwrap();
    let rx2 = t.subscribe_events().unwrap();
    // Two subscribers, one device subscription.
    assert_eq!(dev.commands(), ["subscribe on"]);
    assert_eq!(t.live_subscribers(), 2);

    dev.inject("! INPUT in=0x00000001 t=5");
    let expected = PushEvent::InputChange { inputs: 1, t_us: 5 };
    assert_eq!(rx1.recv_timeout(WAIT).unwrap(), expected);
    assert_eq!(rx2.recv_timeout(WAIT).unwrap(), expected);

    // One leaves: the other keeps receiving and the device stays subscribed.
    drop(rx1);
    dev.inject("! PATTERN_DONE loops=1");
    assert_eq!(
        rx2.recv_timeout(WAIT).unwrap(),
        PushEvent::PatternDone { loops: 1 }
    );
    wait_until("dead subscriber pruned", || t.live_subscribers() == 1);
    t.command("read").unwrap();
    assert_eq!(dev.commands(), ["subscribe on", "read"]);

    // The last one leaves: the next operation switches the device off, once.
    drop(rx2);
    dev.inject("! PATTERN_DONE loops=2");
    wait_until("last subscriber pruned", || t.live_subscribers() == 0);
    t.command("read").unwrap();
    t.command("read").unwrap();
    assert_eq!(
        dev.commands(),
        ["subscribe on", "read", "subscribe off", "read", "read"]
    );

    // A new subscriber switches it on again.
    let _rx3 = t.subscribe_events().unwrap();
    assert_eq!(dev.commands().last().unwrap(), "subscribe on");
}

#[test]
fn resubscribing_before_the_pending_off_reuses_the_device_subscription() {
    let (mut t, dev) = transport_with(basic_device);
    let rx = t.subscribe_events().unwrap();
    drop(rx);
    dev.inject("! PATTERN_DONE loops=1");
    wait_until("subscriber pruned", || t.live_subscribers() == 0);

    let rx2 = t.subscribe_events().unwrap();
    dev.inject("! PATTERN_DONE loops=2");
    assert_eq!(
        rx2.recv_timeout(WAIT).unwrap(),
        PushEvent::PatternDone { loops: 2 }
    );
    assert_eq!(dev.commands(), ["subscribe on"]);
}

#[test]
fn failed_subscribe_on_registers_no_subscriber() {
    let mut refuse = true;
    let (mut t, dev) = transport_with(move |c| {
        if c == "subscribe on" && refuse {
            refuse = false;
            return lines(&["ERR BUSY"]);
        }
        basic_device(c)
    });
    assert_matches!(t.subscribe_events(), Err(SdkError::Busy));
    assert_eq!(t.live_subscribers(), 0);
    // The device is still considered off: a retry sends `subscribe on` again.
    let _rx = t.subscribe_events().unwrap();
    assert_eq!(dev.commands(), ["subscribe on", "subscribe on"]);
}

/// Subscribe, drop the receiver and wait until the reader pruned it, so the
/// next operation has a pending lazy `subscribe off`.
fn leave_pending_subscribe_off(t: &mut Transport, dev: &FakeDevice) {
    let rx = t.subscribe_events().unwrap();
    drop(rx);
    dev.inject("! PATTERN_DONE loops=1");
    wait_until("subscriber pruned", || t.live_subscribers() == 0);
}

#[test]
fn refused_subscribe_off_does_not_fail_or_lock_out_later_commands() {
    let (mut t, dev) = transport_with(|c| match c {
        "subscribe off" => lines(&["ERR BUSY"]),
        other => basic_device(other),
    });
    leave_pending_subscribe_off(&mut t, &dev);

    // The unrelated command succeeds; the refusal is not its error.
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
    // The off was attempted exactly once, not before every command.
    assert_eq!(
        dev.commands(),
        ["subscribe on", "subscribe off", "read", "read"]
    );

    // Device state is unknown after the refusal: a new subscriber asks again.
    let _rx = t.subscribe_events().unwrap();
    assert_eq!(dev.commands().last().unwrap(), "subscribe on");
}

#[test]
fn timed_out_subscribe_off_resyncs_and_does_not_lock_out_later_commands() {
    let mut silent = true;
    let (mut t, dev) = transport_with(move |c| {
        if c == "subscribe off" && silent {
            silent = false;
            return vec![]; // no answer: the lazy off times out
        }
        if c.starts_with("ping ") {
            // The late answer of the timed-out off arrives ahead of the pong.
            let mut late = lines(&["OK"]);
            late.extend(basic_device(c));
            return late;
        }
        basic_device(c)
    });
    leave_pending_subscribe_off(&mut t, &dev);

    // The late answer must not be taken for `read`'s.
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");

    let cmds = dev.commands();
    assert_eq!(cmds.len(), 5, "{cmds:?}");
    assert_eq!(cmds[0], "subscribe on");
    assert_eq!(cmds[1], "subscribe off");
    ping_nonce(&cmds, 2);
    assert_eq!(cmds[3], "read");
    assert_eq!(cmds[4], "read");
}

#[test]
fn timed_out_subscribe_off_with_dead_device_reports_disconnected() {
    // After `subscribe on` the device goes mute: the lazy off times out and
    // the resync ping gets no pong either, so the connection closes.
    let (mut t, dev) = transport_with(|c| match c {
        "subscribe on" => lines(&["OK"]),
        _ => vec![],
    });
    leave_pending_subscribe_off(&mut t, &dev);
    assert_matches!(t.command("read"), Err(SdkError::Disconnected));
    assert_matches!(t.command("read"), Err(SdkError::Disconnected));
}

#[test]
fn push_interleaved_with_response_reaches_events_not_responses() {
    let (mut t, _dev) = transport_with(|c| match c {
        "read" => lines(&["! INPUT in=0x00000005 t=111", "OK in=0x00000003"]),
        other => basic_device(other),
    });
    let events = t.subscribe_events().unwrap();
    assert_eq!(t.command("read").unwrap(), "in=0x00000003");
    assert_eq!(
        events.recv_timeout(WAIT).unwrap(),
        PushEvent::InputChange {
            inputs: 5,
            t_us: 111
        }
    );
}

#[test]
fn push_between_counted_lines_does_not_disturb_the_count() {
    let (mut t, _dev) = transport_with(|c| match c {
        "ts get 85" => lines(&[
            "OK count=2 overflow=0",
            "  in=0x00000001 c=1 p=1 s=1",
            "! INPUT in=0x00000005 t=111",
            "  in=0x00000001 c=2 p=1 s=1",
        ]),
        other => basic_device(other),
    });
    let events = t.subscribe_events().unwrap();
    let (_, body) = t.command_counted("ts get 85").unwrap();
    assert_eq!(body.len(), 2);
    assert_matches!(
        events.recv_timeout(WAIT).unwrap(),
        PushEvent::InputChange { t_us: 111, .. }
    );
}

// --- R-E2: unknown events are logged and dropped ---

#[test]
fn unknown_and_malformed_events_are_dropped_not_queued_or_delivered() {
    let (mut t, dev) = transport_with(|c| match c {
        "read" => lines(&["! FUTURE_EVENT x=1", "! INPUT garbage", "OK in=0x00000001"]),
        other => basic_device(other),
    });
    let events = t.subscribe_events().unwrap();
    // The unknown lines are not the response of `read`.
    assert_eq!(t.command("read").unwrap(), "in=0x00000001");
    // Nor are they delivered.
    assert_matches!(
        events.recv_timeout(Duration::from_millis(100)),
        Err(RecvTimeoutError::Timeout)
    );
    // And the stream is still in step (no resync needed).
    assert_eq!(t.command("version").unwrap(), "fw=0.1.3 proto=2");
    assert!(!dev.commands().iter().any(|c| c.starts_with("ping")));

    // Known events keep flowing afterwards.
    dev.inject("! PATTERN_TIMEOUT loops=4");
    assert_eq!(
        events.recv_timeout(WAIT).unwrap(),
        PushEvent::PatternTimeout { loops: 4 }
    );
}

// --- observer, disconnect, framing ---

#[test]
fn traffic_hook_sees_sent_received_and_event_lines() {
    let (mut t, _dev) = transport_with(|c| match c {
        "read" => lines(&["! INPUT in=0x00000005 t=111", "OK in=0x00000003"]),
        other => basic_device(other),
    });
    let seen: Arc<Mutex<Vec<(TrafficDirection, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let hook_seen = Arc::clone(&seen);
    t.set_traffic_hook(Some(Arc::new(move |dir, line: &str| {
        hook_seen.lock().unwrap().push((dir, line.to_string()));
    })));
    t.command("read").unwrap();
    wait_until("three hook calls", || seen.lock().unwrap().len() >= 3);
    let seen = seen.lock().unwrap();
    assert!(seen.contains(&(TrafficDirection::Sent, "read".to_string())));
    assert!(seen.contains(&(
        TrafficDirection::Event,
        "! INPUT in=0x00000005 t=111".to_string()
    )));
    assert!(seen.contains(&(TrafficDirection::Received, "OK in=0x00000003".to_string())));
}

#[test]
fn traffic_hook_removed_stops_observing() {
    let (mut t, _dev) = transport_with(basic_device);
    let seen: Arc<Mutex<Vec<(TrafficDirection, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let hook_seen = Arc::clone(&seen);
    t.set_traffic_hook(Some(Arc::new(move |dir, line: &str| {
        hook_seen.lock().unwrap().push((dir, line.to_string()));
    })));
    t.set_traffic_hook(None);
    t.command("version").unwrap();
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn disconnect_surfaces_as_disconnected() {
    let (mut t, dev) = transport_with(basic_device);
    drop(dev); // device unplugged
    std::thread::sleep(Duration::from_millis(150));
    assert_matches!(t.command("version"), Err(SdkError::Disconnected));
}

#[test]
fn partial_line_is_assembled_across_reads() {
    let (mut t, dev) = transport_with(|_| vec![]);
    let feeder: JoinHandle<FakeDevice> = std::thread::spawn(move || {
        wait_until("command", || !dev.commands().is_empty());
        dev.inject_raw(b"OK fw=0.");
        std::thread::sleep(Duration::from_millis(40));
        dev.inject_raw(b"1.3 proto=2\r\n");
        dev
    });
    assert_eq!(t.command("version").unwrap(), "fw=0.1.3 proto=2");
    feeder.join().unwrap();
}
