// ============================================================
// mock-device.ts — browser-only virtual Pochi-DIO for E2E tests
//
// Installed from main.tsx when the page is opened with `?mock`
// (dev server only). Replaces the Tauri IPC layer via the official
// @tauri-apps/api mocks, so the production store/components run
// unchanged: invoke() hits the virtual device below and listen()
// receives the same `pochi://*` events the Rust backend emits.
//
// The virtual device mirrors the rig wiring: output channel c is
// looped back to input channel c (GP0→GP12 style), so toggling an
// output flips the matching input, generates waveform edges and —
// when armed — timestamp events.
//
// Test hooks live on window.__POCHI_MOCK__ (files written via
// write_text_file, forced ts overflow, raw device state).
// ============================================================

import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

const NUM_PINS = 23;
const TS_RING = 256;

interface MockMap {
  version: number;
  out_base: number;
  out_count: number;
  in_base: number;
  in_count: number;
  pull: "none" | "up" | "down";
  flags: number;
}

interface MockTsRow {
  inputs: number;
  raw_count: number;
  raw_phase: number;
  sync_active: boolean;
  timestamp_ns: number;
  reconciled: boolean;
}

interface MockStep {
  out_bits: number;
  hold_us: number;
}

const DEFAULT_MAP: MockMap = {
  version: 1,
  out_base: 0,
  out_count: 12,
  in_base: 12,
  in_count: 11,
  pull: "up",
  flags: 0,
};

const DEVICES = [
  {
    uid: "MOCKA1B2C3D4E5F6",
    device_number: 42,
    port: "/dev/mock0",
    version: "0.1.2",
  },
  {
    uid: "MOCKOLDFW0000001",
    device_number: null,
    port: "/dev/mock1",
    version: "0.1.0",
  },
];

export interface MockHandle {
  /// Force the next ts_get to report a device-side ring overflow.
  forceOverflow: boolean;
  /// Files captured by write_text_file (path → contents).
  files: Record<string, string>;
  /// Drive the output word directly (loopback feeds the inputs), as if
  /// an external source toggled the wires — for tests that need edges
  /// while the Output tab is not on screen.
  pulse: (values: number) => void;
  /// Raw device state, for assertions.
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

export function installMockDevice(): void {
  let connected = false;
  let subscribed = false;
  let deviceNumber = 42;
  let map: MockMap = { ...DEFAULT_MAP };
  let outputs = 0;
  let inputs = 0;
  let connectT = 0;

  let tsArmed = false;
  let tsMask = 0;
  let tsMode: "rising" | "falling" | "both" = "rising";
  let tsEvents: MockTsRow[] = [];
  let tsOverflowed = false;

  let patSteps: MockStep[] = [];
  let patState: "idle" | "loaded" | "running" | "done" = "idle";
  let patStep = 0;
  let patLoops = 0;
  let patTimer: ReturnType<typeof setTimeout> | null = null;

  const handle: MockHandle = {
    forceOverflow: false,
    files: {},
    pulse: (values: number) => setOutputs(values, outMask()),
    state: {
      connected,
      subscribed,
      outputs,
      inputs,
      tsArmed,
      deviceNumber,
    },
  };
  window.__POCHI_MOCK__ = handle;

  function syncHandle() {
    handle.state = {
      connected,
      subscribed,
      outputs,
      inputs,
      tsArmed,
      deviceNumber,
    };
  }

  function nowUs(): number {
    return Math.round((performance.now() - connectT) * 1000);
  }

  function log(direction: "sent" | "received" | "event", line: string) {
    void emit("pochi://log", { direction, line });
  }

  function wire(sent: string, received = "OK") {
    log("sent", sent);
    log("received", received);
  }

  function outMask(): number {
    let m = 0;
    for (let c = 0; c < map.out_count; c++) m |= 1 << c;
    return m >>> 0;
  }

  function hex(v: number): string {
    return "0x" + (v >>> 0).toString(16);
  }

  /// Loopback channel c → input channel c; spare inputs idle at pull level.
  function computeInputs(): number {
    const loopback = Math.min(map.out_count, map.in_count);
    const idle = map.pull === "up" ? 1 : 0;
    let word = 0;
    for (let c = 0; c < map.in_count; c++) {
      const v = c < loopback ? (outputs >> c) & 1 : idle;
      word |= v << c;
    }
    return word >>> 0;
  }

  function captureTsEdges(oldIn: number, newIn: number) {
    if (!tsArmed) return;
    const changed = (oldIn ^ newIn) & tsMask;
    if (!changed) return;
    let match = false;
    for (let c = 0; c < NUM_PINS; c++) {
      if (!((changed >> c) & 1)) continue;
      const rising = ((newIn >> c) & 1) === 1;
      if (tsMode === "both" || (tsMode === "rising") === rising) {
        match = true;
        break;
      }
    }
    if (!match) return;
    const ns = nowUs() * 1000;
    const rawCount = Math.floor(ns / 1000);
    const rawPhase = Math.floor((ns % 1000) / 40);
    tsEvents.push({
      inputs: newIn,
      raw_count: rawCount,
      raw_phase: rawPhase,
      sync_active: false,
      timestamp_ns: rawCount * 1000 + rawPhase * 40,
      reconciled: false,
    });
    if (tsEvents.length > TS_RING) {
      tsEvents.shift();
      tsOverflowed = true;
    }
  }

  function setOutputs(values: number, mask: number) {
    outputs = (((values & mask) | (outputs & ~mask)) & outMask()) >>> 0;
    const oldIn = inputs;
    inputs = computeInputs();
    syncHandle();
    if (inputs !== oldIn) {
      captureTsEdges(oldIn, inputs);
      if (subscribed) {
        const t = nowUs();
        log("event", `! INPUT ${hex(inputs)} t=${t}`);
        void emit("pochi://input", { inputs, timestampUs: t });
      }
    }
  }

  function stopPattern() {
    if (patTimer !== null) {
      clearTimeout(patTimer);
      patTimer = null;
    }
  }

  function runPattern(mode: "once" | "loop", repeat: number) {
    patState = "running";
    patStep = 0;
    patLoops = 0;
    const playStep = () => {
      if (patState !== "running") return;
      const step = patSteps[patStep];
      setOutputs(step.out_bits, outMask());
      const holdMs = Math.max(1, step.hold_us / 1000);
      patTimer = setTimeout(() => {
        patStep++;
        if (patStep < patSteps.length) {
          playStep();
          return;
        }
        patLoops++;
        if (mode === "loop" && (repeat === 0 || patLoops < repeat)) {
          patStep = 0;
          playStep();
          return;
        }
        patState = "done";
        patStep = 0;
        log("event", `! PATTERN_DONE loops=${patLoops}`);
        void emit("pochi://pattern-done", { loops: patLoops });
      }, holdMs);
    };
    playStep();
  }

  function requireConnected() {
    if (!connected) throw "not connected";
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
        connected = true;
        connectT = performance.now();
        outputs = 0;
        inputs = computeInputs();
        tsArmed = false;
        tsEvents = [];
        tsOverflowed = false;
        stopPattern();
        patState = "idle";
        syncHandle();
        return DEVICES[0];
      }
      case "disconnect":
        connected = false;
        subscribed = false;
        tsArmed = false;
        stopPattern();
        patState = "idle";
        syncHandle();
        return null;
      case "get_version":
        requireConnected();
        wire("version", "OK v0.1.2 proto=1");
        return { major: 0, minor: 1, patch: 2, protocol_version: 1 };
      case "get_caps":
        requireConnected();
        wire(
          "caps",
          "OK proto=1 dio=23 out=12 in=11 ts_res=40 pattern=256 ring=256 features=1",
        );
        return {
          protocol_version: 1,
          max_dio: NUM_PINS,
          out_count: map.out_count,
          in_count: map.in_count,
          ts_resolution_ns: 40,
          max_pattern_steps: 256,
          ts_ring_events: TS_RING,
          features: 1,
        };
      case "get_info":
        requireConnected();
        return DEVICES[0];
      case "set_device_number":
        requireConnected();
        deviceNumber = args.n;
        syncHandle();
        wire(`devnum ${args.n}`);
        return null;

      // --- io ---
      case "read_inputs":
        requireConnected();
        wire("read", `OK ${hex(inputs)}`);
        return inputs;
      case "read_state":
        requireConnected();
        wire("state", `OK in=${hex(inputs)} out=${hex(outputs)} flags=0x0`);
        return { inputs, outputs, flags: 0 };
      case "write_outputs":
        requireConnected();
        wire(`write ${hex(args.values)} ${hex(args.mask)}`);
        setOutputs(args.values, args.mask);
        return null;
      case "subscribe":
        requireConnected();
        subscribed = args.enable;
        syncHandle();
        wire(`subscribe ${args.enable ? "on" : "off"}`);
        return null;

      // --- pin map ---
      case "map_get":
        requireConnected();
        wire("map get");
        return { ...map };
      case "map_set":
        requireConnected();
        map = { ...args.map };
        wire("map set <hex>");
        setOutputs(outputs, outMask());
        return null;
      case "map_set_hex":
        requireConnected();
        wire(`map set ${args.hex}`);
        return null;
      case "map_save":
        requireConnected();
        wire("map save");
        return null;
      case "map_default":
        requireConnected();
        map = { ...DEFAULT_MAP };
        wire("map default");
        setOutputs(outputs, outMask());
        return null;
      case "map_load_toml":
        return {
          version: 1,
          out_base: 0,
          out_count: 8,
          in_base: 8,
          in_count: 15,
          pull: "down",
          flags: 1,
        };

      // --- pattern ---
      case "pattern_load": {
        requireConnected();
        patSteps = args.steps;
        patState = "loaded";
        const accepted = Math.min(patSteps.length, 256);
        wire(`pattern load ${patSteps.length}`, `OK accepted=${accepted}`);
        return accepted;
      }
      case "pattern_load_toml": {
        // Like the real backend, parsing the file also uploads the steps.
        patSteps = [
          { out_bits: 0x1, hold_us: 100 },
          { out_bits: 0x3, hold_us: 200 },
          { out_bits: 0x7, hold_us: 100 },
          { out_bits: 0xf, hold_us: 300 },
        ];
        patState = "loaded";
        wire("pattern load 4", "OK accepted=4");
        return { steps: [...patSteps], accepted: patSteps.length };
      }
      case "pattern_run":
        requireConnected();
        if (!patSteps.length) throw "pattern empty";
        wire(`pattern run ${args.mode} ${args.repeat}`);
        runPattern(args.mode, args.repeat);
        return null;
      case "pattern_stop":
        requireConnected();
        stopPattern();
        patState = "idle";
        wire("pattern stop");
        return null;
      case "pattern_status":
        requireConnected();
        return {
          state: patState,
          current_step: patStep,
          loops_done: patLoops,
        };

      // --- timestamps ---
      case "ts_arm":
        requireConnected();
        tsArmed = true;
        tsMask = args.mask >>> 0;
        tsMode = args.mode;
        tsEvents = [];
        tsOverflowed = false;
        syncHandle();
        wire(`ts arm ${hex(args.mask)} ${args.mode}`);
        return null;
      case "ts_disarm":
        requireConnected();
        tsArmed = false;
        syncHandle();
        wire("ts disarm");
        return null;
      case "ts_get":
      case "ts_get_reconciled": {
        requireConnected();
        const rows = tsEvents.slice(0, args.maxEvents);
        tsEvents = tsEvents.slice(rows.length);
        const overflow = tsOverflowed || handle.forceOverflow;
        tsOverflowed = false;
        wire(
          `ts get ${args.maxEvents}`,
          `OK count=${rows.length} overflow=${overflow ? 1 : 0}`,
        );
        return {
          events: rows,
          reconciled: cmd === "ts_get_reconciled",
          overflow,
        };
      }

      // --- sync (no GUI yet; REPL/backend parity) ---
      case "sync_arm":
      case "sync_master":
      case "sync_start":
      case "sync_stop":
      case "sync_disarm":
        requireConnected();
        wire(cmd.replace("_", " "));
        return null;
      case "sync_count":
        requireConnected();
        wire("sync count", "OK count=0");
        return 0;

      // --- misc ---
      case "raw_command": {
        requireConnected();
        const text: string = args.text;
        let resp = "OK";
        if (text.startsWith("version")) resp = "OK v0.1.2 proto=1";
        else if (text.startsWith("caps"))
          resp =
            "OK proto=1 dio=23 out=12 in=11 ts_res=40 pattern=256 ring=256 features=1";
        else if (text.startsWith("read")) resp = `OK ${hex(inputs)}`;
        wire(text, resp);
        return resp;
      }
      case "write_text_file":
        handle.files[args.path] = args.contents;
        return null;

      default:
        throw `mock device: unknown command ${cmd}`;
    }
  }

  mockIPC(
    (cmd, args) => {
      try {
        return command(cmd, args);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    { shouldMockEvents: true },
  );
}
