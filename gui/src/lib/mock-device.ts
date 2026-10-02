// ============================================================
// mock-device.ts — browser-only virtual Pochi-DIO for E2E tests
//
// Installed from main.tsx when the page is opened with `?mock`
// (dev server only). Replaces the Tauri IPC layer via the official
// @tauri-apps/api mocks, so the production store/components run
// unchanged: invoke() hits the virtual device below and listen()
// receives the same `pochi://*` events the Rust backend emits.
//
// The device itself is MockDeviceCore (mock-device-core.ts), a v2 text
// protocol model that is replayed against the golden transcripts. This file
// is the thin counterpart of the Rust backend: every Tauri command is turned
// into the wire line(s) the SDK would send, the response is parsed back, and
// the traffic is logged as `pochi://log` like the SDK's traffic hook does.
//
// The virtual device mirrors the rig wiring: the k-th output pin is looped
// back to the k-th input pin, so toggling an output flips the matching input,
// generates waveform edges and, when armed, timestamp events.
//
// Test hooks live on window.__POCHI_MOCK__ (files written via
// write_text_file, forced ts overflow, raw device state).
// ============================================================

import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import {
  GOLDEN_UID,
  MockDeviceCore,
  UnsupportedCommand,
} from "./mock-device-core";
import { PIN_MAP_DEFAULT, type WirePinMap } from "./pinmap";
import { VALID_DIO_MASK } from "./pins";

/// Largest `ts get` the protocol answers in one response.
const TS_GET_MAX = 85;
/// Longest `pattern add` line the device accepts.
const MAX_LINE_BYTES = 256;
/// How often virtual time follows the wall clock.
const CLOCK_TICK_MS = 5;

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
];

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
};

export interface MockHandle {
  /// Force the next ts_get to report a device-side ring overflow.
  forceOverflow: boolean;
  /// Files captured by write_text_file (path → contents).
  files: Record<string, string>;
  /// Drive the output word directly (loopback feeds the inputs), as if
  /// an external source toggled the wires — for tests that need edges
  /// while the Output tab is not on screen. Wire word: bit = GP.
  pulse: (values: number) => void;
  /// Raw device state, for assertions (wire words: bit = GP).
  state: {
    connected: boolean;
    subscribed: boolean;
    outputs: number;
    inputs: number;
    tsArmed: boolean;
    deviceNumber: number;
  };
}

declare global {
  interface Window {
    __POCHI_MOCK__?: MockHandle;
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
    state: {
      connected,
      subscribed: false,
      outputs: 0,
      inputs: 0,
      tsArmed: false,
      deviceNumber: core.deviceNumber,
    },
  };
  window.__POCHI_MOCK__ = handle;

  function syncHandle() {
    handle.state = {
      connected,
      subscribed: core.isSubscribed,
      outputs: core.outputs,
      inputs: core.inputs,
      tsArmed: core.isTsArmed,
      deviceNumber: core.deviceNumber,
    };
  }

  function log(direction: "sent" | "received" | "event", line: string) {
    void emit("pochi://log", { direction, line });
  }

  /// Turn the device's queued `! ...` lines into log lines and, like the
  /// backend forwarder, into `pochi://*` events.
  function flushEvents() {
    for (const line of core.takeEvents()) {
      log("event", line);
      if (!forwarding) continue;
      const input = /^! INPUT in=(0x[0-9a-f]+) t=(\d+)$/.exec(line);
      const done = /^! PATTERN_DONE loops=(\d+)$/.exec(line);
      if (input) {
        void emit("pochi://input", {
          inputs: Number(input[1]) >>> 0,
          timestampUs: Number(input[2]),
        });
      } else if (done) {
        void emit("pochi://pattern-done", { loops: Number(done[1]) });
      } else {
        void emit("pochi://unknown-event", { raw: line });
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
      const code = header.slice(4).trim();
      throw `device error: ${code} (${ERROR_TEXT[code] ?? code})`;
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
        // Power-cycle semantics: RAM state resets, flash (saved map,
        // device number) survives.
        core = new MockDeviceCore({
          uid: GOLDEN_UID,
          flashMap: core.savedMap ?? RIG_MAP,
          devnum: core.deviceNumber,
          loopback: true,
        });
        clockOriginMs = performance.now();
        connected = true;
        forwarding = false;
        syncHandle();
        return DEVICES[0];
      }
      case "disconnect":
        connected = false;
        forwarding = false;
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
        return { ...DEVICES[0], device_number: n === 255 ? null : n };
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
        syncHandle();
        return null;
      case "bootsel_reset":
        run("bootsel");
        connected = false;
        forwarding = false;
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

      // --- sync (no GUI yet; backend parity only) ---
      case "sync_arm":
      case "sync_master":
      case "sync_start":
      case "sync_stop":
      case "sync_count":
      case "sync_disarm":
        throw "mock device: sync is not modelled";

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
