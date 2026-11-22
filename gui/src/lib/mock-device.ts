// ============================================================
// mock-device.ts — browser-only virtual Tcapi-DIO for E2E tests
//
// Installed from main.tsx when the page is opened with `?mock`
// (dev server only). Replaces the Tauri IPC layer via the official
// @tauri-apps/api mocks, so the production store/components run
// unchanged: invoke() hits the virtual device below and listen()
// receives the same `tcapi://*` events the Rust backend emits.
//
// The device itself is MockDeviceCore (mock-device-core.ts), a v2 text
// protocol model that is replayed against the golden transcripts. This file
// is the thin counterpart of the Rust backend: every Tauri command is turned
// into the wire line(s) the SDK would send, the response is parsed back, and
// the traffic is logged as `tcapi://log` like the SDK's traffic hook does.
//
// The virtual device mirrors the rig wiring: the k-th output pin is looped
// back to the k-th input pin, so toggling an output flips the matching input,
// generates waveform edges and, when armed, timestamp events.
//
// Test hooks live on window.__TCAPI_MOCK__ (files written via
// write_text_file, forced ts overflow, raw device state).
// ============================================================

import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import {
  GOLDEN_UID,
  MockDeviceCore,
  UnsupportedCommand,
  type UsbState,
} from "./mock-device-core";
import { FEATURES_ALL } from "./features";
import { PIN_MAP_DEFAULT, type WirePinMap } from "./pinmap";
import { VALID_DIO_MASK } from "./pins";
import { heartbeatIntervalMs, type SafetyConfig } from "./safety";

/// Largest `ts get` the protocol answers in one response.
const TS_GET_MAX = 85;
/// Longest `pattern add` line the device accepts.
const MAX_LINE_BYTES = 256;
/// How often virtual time follows the wall clock.
const CLOCK_TICK_MS = 5;
/// `devnum` sentinel for "unassigned" (wire `devnum=255`).
const DEVNUM_UNASSIGNED = 255;

/// Map the rig boots with (saved in the virtual flash): GP0-GP11 are
/// outputs, every other pin an input with pull-down and edge events.
const RIG_MAP: WirePinMap = {
  ...PIN_MAP_DEFAULT,
  direction: 0x00000fff,
  pull_down: (VALID_DIO_MASK & ~0x00000fff) >>> 0,
  edge: (VALID_DIO_MASK & ~0x00000fff) >>> 0,
};

/// Map the canned `sample.toml` of the file dialog evaluates to: GP0-GP7 are
/// outputs.
const SAMPLE_MAP: WirePinMap = {
  ...PIN_MAP_DEFAULT,
  direction: 0x000000ff,
  pull_down: (VALID_DIO_MASK & ~0x000000ff) >>> 0,
  edge: (VALID_DIO_MASK & ~0x000000ff) >>> 0,
};

/// Steps the canned `sample.toml` pattern evaluates to (200 ns ticks).
const SAMPLE_PATTERN = [
  { out_bits: 0x1, hold_ticks: 500 },
  { out_bits: 0x3, hold_ticks: 1000 },
  { out_bits: 0x7, hold_ticks: 500 },
  { out_bits: 0xf, hold_ticks: 1500 },
];

/// Device number of the healthy mock unit.
const GOOD_DEVICE_NUMBER = 42;
/// Device number of the second healthy mock unit (multi-device scenarios:
/// the app connects to one unit at a time, so "two devices" is modelled as
/// two devices to choose from, not two simultaneous connections).
const SECOND_DEVICE_NUMBER = 43;

const DEVICES = [
  {
    uid: "MOCKA1B2C3D4E5F6",
    device_number: GOOD_DEVICE_NUMBER,
    port: "/dev/mock0",
    version: "0.1.3",
  },
  {
    uid: "MOCKOLDFW0000001",
    device_number: null,
    port: "/dev/mock1",
    version: "0.1.0",
  },
  {
    uid: "MOCKB2C3D4E5F6A1",
    device_number: SECOND_DEVICE_NUMBER,
    port: "/dev/mock2",
    version: "0.1.3",
  },
];

/// `caps feat=` of the units that are not fully featured, by port. The
/// second healthy unit runs firmware from before the safety features (sync
/// and reset only), so the GUI must hide every safety control for it.
const LEGACY_FEATURES: Record<string, number> = { "/dev/mock2": 0x03 };

/// What the canned `safety.toml` of the file dialog evaluates to.
const SAMPLE_SAFETY: SafetyConfig = {
  watchdog_ms: 1000,
  usbsafe: true,
  groups: [0x00000003, 0x0000000c],
};

const ERROR_TEXT: Record<string, string> = {
  BAD_CMD: "unknown command",
  UNKNOWN_CMD: "unknown command",
  BAD_PARAM: "invalid parameter",
  BAD_MAP: "map validation failed",
  BUSY: "device is busy",
  FLASH: "flash write/read failed",
  TOO_LONG: "payload too long",
  LINE_TOO_LONG: "payload too long",
  NOT_ARMED: "timestamp not armed",
  SYNC_STATE: "invalid sync state transition",
  NO_RESOURCE: "required resource not configured",
  NOT_RUNNING: "pattern not running",
  FAILSAFE: "failsafe latch is set",
};

/// The message the SDK gives a device error (`SdkError` display): the name
/// and a text, and for `ERR EXCLUSIVE group=<i> mask=0x...` the group and mask.
function deviceErrorText(header: string): string {
  const [code, ...data] = header.slice(4).trim().split(/\s+/);
  if (code === "EXCLUSIVE") {
    const kv = fields("EXCLUSIVE " + data.join(" "));
    return `device error: EXCLUSIVE (exclusive group ${kv.group} would be violated, mask ${kv.mask})`;
  }
  return `device error: ${code} (${ERROR_TEXT[code] ?? code})`;
}

export interface MockHandle {
  /// Force the next ts_get to report a device-side ring overflow.
  forceOverflow: boolean;
  /// Files captured by write_text_file (path → contents).
  files: Record<string, string>;
  /// Drive the output word directly (loopback feeds the inputs), as if
  /// an external source toggled the wires — for tests that need edges
  /// while the Output tab is not on screen. Wire word: bit = GP.
  pulse: (values: number) => void;
  /// External sync bus edge (GP28): starts this unit's clock if it is
  /// `sync arm`-ed as a slave — a test's stand-in for a master elsewhere
  /// on the bus producing the edge (the mock does not model the bus itself).
  syncEdge: () => void;
  /// Make the next `safety_load_toml` fail with this message (the SDK's
  /// `file:line: message` shape), once.
  safetyTomlError: string | null;
  /// The host heartbeat dies with this message, as when a ping fails: the
  /// backend reports `tcapi://heartbeat-failed` and the watchdog, left unfed,
  /// trips on the virtual clock.
  failHeartbeat: (message: string) => void;
  /// The USB state the device sees (`usbsafe` trips when it leaves configured).
  usb: (state: UsbState) => void;
  /// Raw device state, for assertions (wire words: bit = GP).
  state: {
    connected: boolean;
    subscribed: boolean;
    outputs: number;
    inputs: number;
    tsArmed: boolean;
    deviceNumber: number;
    /// Watchdog timeout the heartbeat is feeding (0 = no heartbeat).
    heartbeatMs: number;
  };
}

declare global {
  interface Window {
    __TCAPI_MOCK__?: MockHandle;
  }
}

function hex(v: number): string {
  return "0x" + (v >>> 0).toString(16);
}

/// `OK k=v k=v` → fields. Values stay text.
function fields(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of header.split(/\s+/).slice(1)) {
    const eq = tok.indexOf("=");
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

function num(fieldsOf: Record<string, string>, key: string): number {
  const v = Number(fieldsOf[key]);
  if (!Number.isFinite(v)) throw `mock device: missing or bad field ${key}`;
  return v >>> 0;
}

function parseSafety(f: Record<string, string>) {
  return {
    wdog_ms: num(f, "wdog_ms"),
    remaining_ms: num(f, "remaining_ms"),
    failsafe: f.failsafe === "1",
    cause: f.cause,
    usbsafe: f.usbsafe === "1",
    excl: num(f, "excl"),
  };
}

function parseMap(header: string): WirePinMap {
  const f = fields(header);
  return {
    flags: num(f, "flags"),
    direction: num(f, "dir"),
    pull_up: num(f, "pu"),
    pull_down: num(f, "pd"),
    out_default: num(f, "def"),
    out_polarity: num(f, "opol"),
    in_polarity: num(f, "ipol"),
    edge: num(f, "edge"),
  };
}

function mapSetArgs(m: WirePinMap): string {
  return (
    `v=2 flags=${"0x" + (m.flags & 0xff).toString(16).padStart(2, "0")} ` +
    `dir=${hex8(m.direction)} pu=${hex8(m.pull_up)} pd=${hex8(m.pull_down)} ` +
    `def=${hex8(m.out_default)} opol=${hex8(m.out_polarity)} ipol=${hex8(m.in_polarity)} ` +
    `edge=${hex8(m.edge)}`
  );
}

function hex8(v: number): string {
  return "0x" + (v >>> 0).toString(16).padStart(8, "0");
}

interface WireStep {
  out_bits: number;
  hold_ticks: number;
}

/// `pattern add` lines for `steps`, packed up to the line limit.
function patternAddLines(steps: WireStep[]): string[] {
  if (steps.length === 0) throw "invalid argument: pattern must have at least one step";
  const prefix = "pattern add";
  const lines: string[] = [];
  let line = prefix;
  for (const s of steps) {
    const text = `${hex(s.out_bits)}:${s.hold_ticks}`;
    if (line.length + 1 + text.length > MAX_LINE_BYTES) {
      lines.push(line);
      line = prefix;
    }
    line += " " + text;
  }
  lines.push(line);
  return lines;
}

export function installMockDevice(): void {
  let connected = false;
  /// Port of the currently (or most recently) connected unit, to tell a
  /// reconnect of the same unit from switching to a different one.
  let connectedPort: string | null = null;
  /// Whether the UI forwarder is attached (the backend only forwards push
  /// events to the webview while it is).
  let forwarding = false;
  let core = new MockDeviceCore({
    uid: GOLDEN_UID,
    flashMap: RIG_MAP,
    devnum: GOOD_DEVICE_NUMBER,
    loopback: true,
  });
  let clockOriginMs = performance.now();

  const handle: MockHandle = {
    forceOverflow: false,
    files: {},
    pulse: (values: number) => {
      run(`write ${hex(values)} ${hex(core.currentMap.direction)}`);
    },
    syncEdge: () => {
      requireConnected();
      core.syncEdge();
    },
    state: {
      connected,
      subscribed: false,
      outputs: 0,
      inputs: 0,
      tsArmed: false,
      deviceNumber: core.deviceNumber,
      heartbeatMs: 0,
    },
    safetyTomlError: null,
    failHeartbeat: (message: string) => {
      requireConnected();
      stopHeartbeat();
      void emit("tcapi://heartbeat-failed", { message });
    },
    usb: (state: UsbState) => {
      requireConnected();
      tick();
      core.setUsbState(state);
      flushEvents();
      syncHandle();
    },
  };
  window.__TCAPI_MOCK__ = handle;

  function syncHandle() {
    handle.state = {
      connected,
      subscribed: core.isSubscribed,
      outputs: core.outputs,
      inputs: core.inputs,
      tsArmed: core.isTsArmed,
      deviceNumber: core.deviceNumber,
      heartbeatMs,
    };
  }

  // --- watchdog heartbeat ---
  // The backend keeps an enabled watchdog fed with `ping` every timeout/4
  // (at most 1 s). The mock does the same on the wall clock; the pings are
  // not echoed to the command log (they would bury every other line).
  let heartbeatMs = 0;
  let heartbeatTimer: number | null = null;

  function stopHeartbeat() {
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    heartbeatMs = 0;
  }

  /// Follow the watchdog the device ended up with: restart the heartbeat for
  /// `ms`, or stop it for `0`.
  function followWatchdog(ms: number) {
    stopHeartbeat();
    if (ms === 0) return;
    heartbeatMs = ms;
    heartbeatTimer = window.setInterval(() => {
      if (!connected) return;
      tick();
      core.execute("ping 0");
    }, heartbeatIntervalMs(ms));
  }

  function log(direction: "sent" | "received" | "event", line: string) {
    void emit("tcapi://log", { direction, line });
  }

  /// Turn the device's queued `! ...` lines into log lines and, like the
  /// backend forwarder, into `tcapi://*` events.
  function flushEvents() {
    for (const line of core.takeEvents()) {
      log("event", line);
      if (!forwarding) continue;
      const input = /^! INPUT in=(0x[0-9a-f]+) t=(\d+)$/.exec(line);
      const done = /^! PATTERN_DONE loops=(\d+)$/.exec(line);
      const failsafe = /^! FAILSAFE cause=(wdog|usb)$/.exec(line);
      if (input) {
        void emit("tcapi://input", {
          inputs: Number(input[1]) >>> 0,
          timestampUs: Number(input[2]),
        });
      } else if (done) {
        void emit("tcapi://pattern-done", { loops: Number(done[1]) });
      } else if (failsafe) {
        void emit("tcapi://failsafe", { cause: failsafe[1] });
      } else {
        void emit("tcapi://unknown-event", { raw: line });
      }
    }
  }

  /// Let virtual time catch up with the wall clock.
  function tick() {
    const target = Math.round((performance.now() - clockOriginMs) * 1e6);
    if (target > core.nowNs) core.advanceTo(target);
    flushEvents();
    syncHandle();
  }

  function requireConnected() {
    if (!connected) throw "Not connected";
  }

  /// Send one line, log the traffic and return the response lines.
  /// Device errors throw the message the Rust backend would return.
  function run(line: string): string[] {
    requireConnected();
    tick();
    log("sent", line);
    const lines = core.execute(line);
    for (const l of lines) log("received", l);
    flushEvents();
    syncHandle();
    const header = lines[0] ?? "";
    if (header.startsWith("ERR ")) {
      throw deviceErrorText(header);
    }
    return lines;
  }

  /// `run` that returns the fields of the header line.
  function runFields(line: string): Record<string, string> {
    return fields(run(line)[0]);
  }

  function loadPattern(steps: WireStep[]): number {
    patternAddLines(steps); // reject an empty pattern before touching the device
    run("pattern reset");
    let total = 0;
    for (const line of patternAddLines(steps)) {
      total = num(runFields(line), "total");
    }
    return total;
  }

  function tsGet(maxEvents: number, reconciled: boolean) {
    const rows: {
      inputs: number;
      raw_count: number;
      raw_phase: number;
      sync_active: boolean;
      timestamp_ns: number;
      reconciled: boolean;
    }[] = [];
    let overflow = false;
    let remaining = maxEvents;
    if (handle.forceOverflow) core.markTsOverflow();
    while (remaining > 0) {
      const chunk = Math.min(remaining, TS_GET_MAX);
      const lines = run(`ts get ${chunk}`);
      const head = fields(lines[0]);
      overflow = overflow || head.overflow === "1";
      for (const l of lines.slice(1)) {
        const f = fields("OK " + l.trim());
        const count = num(f, "c");
        const phase = num(f, "p");
        const sync = f.s === "1";
        rows.push({
          inputs: num(f, "in"),
          raw_count: count,
          raw_phase: phase,
          sync_active: sync,
          timestamp_ns: count * 1000 + (sync ? phase * 40 : 0),
          reconciled: false,
        });
      }
      remaining -= chunk;
      if (lines.length - 1 < chunk) break;
    }
    return { events: rows, reconciled, overflow };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function command(cmd: string, args: any): unknown {
    switch (cmd) {
      // --- dialogs (plugin:dialog) ---
      case "plugin:dialog|open":
        return "/mock/sample.toml";
      case "plugin:dialog|save":
        return "/mock/" + (args?.options?.defaultPath ?? "export.txt");

      // --- discovery / connection ---
      case "discover":
        return DEVICES;
      case "connect": {
        if (args.port === "/dev/mock1") {
          throw `connect ${args.port}: unsupported firmware (old ts format, ts_res=1000)`;
        }
        const dev = DEVICES.find((d) => d.port === args.port) ?? DEVICES[0];
        // Power-cycle semantics: a fresh device boots from its own flash
        // (saved map, device number); reconnecting the same unit keeps the
        // RAM-level identity (uid/devnum) it already has, flash included.
        const sameUnit = connectedPort === args.port;
        core = new MockDeviceCore({
          uid: sameUnit ? core.uid : dev.uid,
          flashMap: sameUnit ? core.savedMap ?? RIG_MAP : RIG_MAP,
          devnum: sameUnit ? core.deviceNumber : (dev.device_number ?? DEVNUM_UNASSIGNED),
          loopback: true,
          features: LEGACY_FEATURES[dev.port] ?? FEATURES_ALL,
        });
        connectedPort = args.port;
        stopHeartbeat();
        clockOriginMs = performance.now();
        connected = true;
        forwarding = false;
        syncHandle();
        return {
          ...dev,
          device_number: core.deviceNumber === DEVNUM_UNASSIGNED ? null : core.deviceNumber,
        };
      }
      case "disconnect":
        connected = false;
        forwarding = false;
        stopHeartbeat();
        syncHandle();
        return null;
      case "get_version": {
        const f = runFields("version");
        const [major, minor, patch] = (f.fw ?? "").split(".").map(Number);
        return { major, minor, patch, protocol_version: num(f, "proto") };
      }
      case "get_caps": {
        const f = runFields("caps");
        return {
          dio: num(f, "dio"),
          out: num(f, "out"),
          in: num(f, "in"),
          ts_res_ns: num(f, "ts_res_ns"),
          tick_ns: num(f, "tick_ns"),
          pattern_max: num(f, "pattern"),
          ring: num(f, "ring"),
          features: num(f, "feat"),
        };
      }
      case "get_info": {
        const f = runFields("info");
        const n = num(f, "devnum");
        const dev = DEVICES.find((d) => d.port === connectedPort) ?? DEVICES[0];
        return { ...dev, uid: f.uid, device_number: n === DEVNUM_UNASSIGNED ? null : n };
      }
      case "set_device_number":
        run(`devnum ${args.n}`);
        return null;

      // --- io ---
      case "read_inputs":
        return num(runFields("read"), "in");
      case "read_state": {
        const f = runFields("state");
        return { inputs: num(f, "in"), outputs: num(f, "out") };
      }
      case "write_outputs":
        run(`write ${hex(args.values)} ${hex(args.mask)}`);
        return null;
      case "subscribe":
        run(`subscribe ${args.enable ? "on" : "off"}`);
        forwarding = Boolean(args.enable);
        return null;

      // --- pin map ---
      case "map_get":
        return parseMap(run("map get")[0]);
      case "map_set":
        run(`map set ${mapSetArgs(args.map)}`);
        return null;
      case "map_save":
        run("map save");
        return null;
      case "map_default":
        run("map default");
        return null;
      case "map_load_toml":
        // Evaluating a file does not touch the device (the real backend
        // parses it through the SDK config parser); the dialog always
        // yields /mock/sample.toml.
        return { ...SAMPLE_MAP };

      // --- pattern ---
      case "pattern_load":
        return loadPattern(args.steps);
      case "pattern_load_toml": {
        // Like the real backend, parsing the file also uploads the steps.
        const accepted = loadPattern(SAMPLE_PATTERN);
        return { steps: SAMPLE_PATTERN.map((s) => ({ ...s })), accepted };
      }
      case "pattern_run":
        run(args.mode === "loop" ? `pattern run loop ${args.repeat}` : "pattern run once");
        return null;
      case "pattern_stop":
        run("pattern stop");
        return null;
      case "pattern_reset":
        run("pattern reset");
        return null;
      case "system_reset":
        run("reset");
        connected = false;
        forwarding = false;
        stopHeartbeat();
        syncHandle();
        return null;
      case "bootsel_reset":
        run("bootsel");
        connected = false;
        forwarding = false;
        stopHeartbeat();
        syncHandle();
        return null;
      case "pattern_status": {
        const f = runFields("pattern status");
        return {
          state: f.state,
          step: num(f, "step"),
          loops: num(f, "loops"),
          total: num(f, "total"),
        };
      }

      // --- timestamps ---
      case "ts_arm":
        run(`ts arm ${hex(args.mask)} ${args.mode}`);
        return null;
      case "ts_disarm":
        run("ts disarm");
        return null;
      case "ts_get":
      case "ts_get_reconciled":
        return tsGet(args.maxEvents, cmd === "ts_get_reconciled");

      // --- safety ---
      case "wdog":
        run(`wdog ${args.ms}`);
        followWatchdog(args.ms);
        return null;
      case "get_safety":
        return parseSafety(runFields("safety"));
      case "failsafe_clear":
        run("failsafe clear");
        return null;
      case "outputs_reset":
        run("outputs reset");
        return null;
      case "excl_set":
        run(`excl set ${(args.masks as number[]).map(hex).join(" ")}`);
        return null;
      case "excl_clear":
        run("excl clear");
        return null;
      case "excl_get":
        return run("excl get")
          .slice(1)
          .map((l) => num(fields("OK " + l.trim()), "mask"));
      case "usbsafe":
        run(`usbsafe ${args.on ? "on" : "off"}`);
        return null;
      case "safety_load_toml": {
        // Evaluating a file does not touch the device; the dialog always
        // yields /mock/sample.toml. A test can make the evaluation fail.
        const error = handle.safetyTomlError;
        if (error !== null) {
          handle.safetyTomlError = null;
          throw error;
        }
        return { ...SAMPLE_SAFETY, groups: [...SAMPLE_SAFETY.groups] };
      }
      case "apply_safety": {
        const config = args.config as SafetyConfig;
        // The commands the SDK sends, in its order (excl, usbsafe, wdog).
        run(
          config.groups.length === 0
            ? "excl clear"
            : `excl set ${config.groups.map(hex).join(" ")}`,
        );
        run(`usbsafe ${config.usbsafe ? "on" : "off"}`);
        run(`wdog ${config.watchdog_ms}`);
        followWatchdog(config.watchdog_ms);
        return parseSafety(runFields("safety"));
      }

      // --- sync (no GUI tab yet; reachable from the raw command console) ---
      case "sync_arm":
        run("sync arm");
        return null;
      case "sync_master":
        run("sync master");
        return null;
      case "sync_start":
        run("sync start");
        return null;
      case "sync_stop":
        run("sync stop");
        return null;
      case "sync_disarm":
        run("sync disarm");
        return null;
      case "sync_count":
        return num(runFields("sync count"), "clocks");

      // --- misc ---
      case "raw_command": {
        requireConnected();
        tick();
        const text: string = args.text;
        log("sent", text);
        const lines = core.execute(text);
        for (const l of lines) log("received", l);
        flushEvents();
        syncHandle();
        return lines.join("\n");
      }
      case "write_text_file":
        handle.files[args.path] = args.contents;
        return null;

      default:
        throw `mock device: unknown command ${cmd}`;
    }
  }

  window.setInterval(() => {
    if (connected) tick();
  }, CLOCK_TICK_MS);

  mockIPC(
    (cmd, args) => {
      try {
        return command(cmd, args);
      } catch (e) {
        if (e instanceof UnsupportedCommand) return Promise.reject(e.message);
        return Promise.reject(e);
      }
    },
    { shouldMockEvents: true },
  );
}
