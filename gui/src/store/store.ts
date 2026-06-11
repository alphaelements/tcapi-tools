// ============================================================
// store.ts — global store (version-key + useSyncExternalStore)
//
// Ported from design-reference store.jsx: the store mechanism
// (version keys, snap, bump) and every action name are kept;
// the simulation half (GEN_PRESETS / genValue / tick / fake
// responses) is replaced by Tauri invoke/listen per the mapping
// table in wiki ja-GUI-Spec §9.
// ============================================================

import { useSyncExternalStore } from "react";
import { fmt } from "../lib/fmt";
import { EdgeHistory } from "../lib/ring";
import { invoke, listen, tauriAvailable } from "../lib/tauri";

export const NUM_PINS = 23;

// ---- wire types (serde snake_case from the Rust backend) ----

interface WireDeviceInfo {
  uid: string;
  device_number: number | null;
  port: string;
  version: string | null;
}
interface WireVersionInfo {
  major: number;
  minor: number;
  patch: number;
  protocol_version: number;
}
interface WireCapabilities {
  protocol_version: number;
  max_dio: number;
  out_count: number;
  in_count: number;
  ts_resolution_ns: number;
  max_pattern_steps: number;
  ts_ring_events: number;
  features: number;
}
interface WirePinMap {
  version: number;
  out_base: number;
  out_count: number;
  in_base: number;
  in_count: number;
  pull: "none" | "up" | "down";
  flags: number;
}
interface WireIoState {
  inputs: number;
  outputs: number;
  flags: number;
}
interface WirePatternStatus {
  state: "idle" | "loaded" | "running" | "done";
  current_step: number;
  loops_done: number;
}
interface WireTsRow {
  inputs: number;
  raw_count: number;
  raw_phase: number;
  sync_active: boolean;
  timestamp_ns: number;
  reconciled: boolean;
}
interface WireTsResult {
  events: WireTsRow[];
  reconciled: boolean;
  overflow: boolean;
}
interface WirePatternTomlPayload {
  steps: { out_bits: number; hold_us: number }[];
  accepted: number;
}

// ---- store types ----

export type ConnStatus = "disconnected" | "connecting" | "connected" | "error";
export type LogDirection = "sent" | "received" | "event" | "error";

export interface DeviceEntry {
  uid: string;
  num: number | null;
  port: string;
  fw: string | null;
}
export interface PinMeta {
  gp: number;
  value: number;
  lastChangeMs: number | null;
  pull: string;
  edges: number;
}
export interface PatternStepUi {
  out: number;
  hold: number;
}
export interface TsRowUi {
  idx: number;
  inputs: number;
  rawCount: number;
  rawPhase: number;
  syncActive: boolean;
  computedNs: number;
  reconciled: boolean;
}
export interface LogEntry {
  id: string;
  ts: Date;
  direction: LogDirection;
  text: string;
}

export type VersionKey =
  | "conn"
  | "pins"
  | "log"
  | "pattern"
  | "ts"
  | "map"
  | "sim"
  | "ui";

interface StoreState {
  // connection
  connStatus: ConnStatus;
  scanning: boolean;
  devices: DeviceEntry[];
  selectedUid: string | null;
  connectedUid: string | null;
  version: { fw: string; proto: string } | null;
  capabilities: {
    pins: number;
    inCount: number;
    maxPattern: number;
    tsDepth: number;
    clockMhz: number;
    sync: boolean;
  } | null;
  subscribed: boolean;

  // pins
  splitIndex: number;
  pinMeta: PinMeta[];
  inputs: number;
  outputs: number;
  pullDefault: "up" | "down" | "none";
  mapFlags: number;
  mapApplied: boolean;

  // waveform
  monitored: Set<number>;
  cursors: { t: number }[];
  recording: boolean;
  windowUs: number;
  followLive: boolean;

  // pattern
  pattern: {
    steps: PatternStepUi[];
    accepted: number | null;
    mode: "once" | "loop";
    repeat: number;
    playState: "idle" | "running" | "done";
    curStep: number;
    loops: number;
  };

  // timestamp
  ts: {
    armed: boolean;
    mask: number;
    edge: "rising" | "falling" | "both";
    result: {
      rows: TsRowUi[];
      reconciled: boolean;
      overflow: boolean;
      span: number;
    } | null;
    bufferEst: number;
  };

  // log
  log: LogEntry[];
  maxLog: number;

  // stream clock (µs since connect; drives waveform + status bar)
  streamT: number;
  _running: boolean;
  _t0: number;
  _pausedAt: number | null;
  _tsOffset: number | null;
}

function createStore() {
  const versions: Record<VersionKey, number> = {
    conn: 0,
    pins: 0,
    log: 0,
    pattern: 0,
    ts: 0,
    map: 0,
    sim: 0,
    ui: 0,
  };
  const subs = new Set<() => void>();
  function bump(...keys: VersionKey[]) {
    keys.forEach((k) => {
      versions[k] = (versions[k] + 1) % 1e9;
    });
    subs.forEach((fn) => fn());
  }
  function snap(keys: VersionKey[]) {
    return keys.map((k) => k + versions[k]).join("|");
  }

  // initial pin meta
  const SPLIT = 8; // demo default until map_get reflects the device
  const pinMeta: PinMeta[] = [];
  for (let i = 0; i < NUM_PINS; i++) {
    pinMeta.push({ gp: i, value: 0, lastChangeMs: null, pull: "none", edges: 0 });
  }

  const S: StoreState = {
    connStatus: "disconnected",
    scanning: false,
    devices: [],
    selectedUid: null,
    connectedUid: null,
    version: null,
    capabilities: null,
    subscribed: true,

    splitIndex: SPLIT,
    pinMeta,
    inputs: 0,
    outputs: 0,
    pullDefault: "down",
    mapFlags: 0x03,
    mapApplied: true,

    monitored: new Set<number>(),
    cursors: [{ t: 1500 }, { t: 3600 }],
    recording: true,
    windowUs: 6000,
    followLive: true,

    pattern: {
      steps: [],
      accepted: null,
      mode: "loop",
      repeat: 0,
      playState: "idle",
      curStep: 0,
      loops: 0,
    },

    ts: { armed: false, mask: 0, edge: "rising", result: null, bufferEst: 0 },

    log: [],
    maxLog: 800,

    streamT: 0,
    _running: false,
    _t0: 0,
    _pausedAt: null,
    _tsOffset: null,
  };

  // edge-history ring buffers (waveform data source)
  const history: EdgeHistory[] = [];
  for (let i = 0; i < NUM_PINS; i++) history.push(new EdgeHistory());

  function gpDir(gp: number): "output" | "input" {
    return gp < S.splitIndex ? "output" : "input";
  }

  function log(direction: LogDirection, text: string) {
    S.log.push({
      id: Math.random().toString(36).slice(2),
      ts: new Date(),
      direction,
      text,
    });
    if (S.log.length > S.maxLog) S.log.splice(0, S.log.length - S.maxLog);
    bump("log");
  }

  function logError(context: string, e: unknown) {
    log("error", `${context}: ${e instanceof Error ? e.message : String(e)}`);
  }

  function nowStreamT(): number {
    return (performance.now() - S._t0) * 1000;
  }

  // Wire words pack one bit per *channel* (`read`: "bit N corresponds to
  // input channel N"), not per GP. With the UI's single-split map model,
  // output channel c = GP c and input channel c = GP (splitIndex + c).
  function applyPinValues(word: number, dir: "input" | "output", t: number) {
    const base = dir === "output" ? 0 : S.splitIndex;
    const count = dir === "output" ? S.splitIndex : NUM_PINS - S.splitIndex;
    for (let c = 0; c < count; c++) {
      const gp = base + c;
      const v = (word >> c) & 1;
      const m = S.pinMeta[gp];
      if (v !== m.value) {
        m.value = v;
        m.lastChangeMs = t;
        m.edges++;
        history[gp].push(t, v as 0 | 1);
      }
    }
  }

  // ---- push event handling (Tauri events from the backend) ----

  let listenersInstalled = false;
  function installListeners() {
    if (listenersInstalled || !tauriAvailable) return;
    listenersInstalled = true;

    void listen<{ direction: LogDirection; line: string }>(
      "pochi://log",
      (p) => log(p.direction, p.line),
    );

    void listen<{ inputs: number; timestampUs: number }>(
      "pochi://input",
      (p) => {
        if (S.connStatus !== "connected") return;
        // Lock device time to the stream clock at the first event, then
        // keep inter-event spacing from the device timestamps.
        if (S._tsOffset === null) S._tsOffset = nowStreamT() - p.timestampUs;
        const t = Math.min(p.timestampUs + S._tsOffset, nowStreamT());
        if (S.ts.armed) S.ts.bufferEst++;
        S.inputs = p.inputs >>> 0;
        applyPinValues(S.inputs, "input", t);
        bump("pins");
        if (S.ts.armed) bump("ts");
      },
    );

    void listen<{ loops: number }>("pochi://pattern-done", (p) => {
      S.pattern.playState = "done";
      S.pattern.loops = p.loops;
      stopPatternPoll();
      bump("pattern");
    });

    // sync has no GUI yet (not in the mock); surfaced via pochi://log.
    void listen<{ raw: string }>("pochi://unknown-event", () => {});
  }

  // ---- pattern status polling while running ----

  let patternPoll: ReturnType<typeof setInterval> | null = null;
  function stopPatternPoll() {
    if (patternPoll !== null) {
      clearInterval(patternPoll);
      patternPoll = null;
    }
  }
  function startPatternPoll() {
    stopPatternPoll();
    patternPoll = setInterval(() => {
      if (S.pattern.playState !== "running") {
        stopPatternPoll();
        return;
      }
      invoke<WirePatternStatus>("pattern_status")
        .then((st) => {
          if (S.pattern.playState !== "running") return;
          S.pattern.curStep = st.current_step;
          S.pattern.loops = st.loops_done;
          if (st.state === "done" || st.state === "idle") {
            S.pattern.playState = st.state === "done" ? "done" : "idle";
            stopPatternPoll();
          }
          bump("pattern");
        })
        .catch(() => {
          /* transient poll failure; push event still ends the run */
        });
    }, 350);
  }

  function outputMask(): number {
    let m = 0;
    for (let gp = 0; gp < S.splitIndex; gp++) m |= 1 << gp;
    return m >>> 0;
  }

  function resetDeviceState() {
    S.connectedUid = null;
    S.version = null;
    S.capabilities = null;
    S.pattern.playState = "idle";
    S.outputs = 0;
    S.inputs = 0;
    S.ts.armed = false;
    S.ts.result = null;
    S.ts.bufferEst = 0;
    S._tsOffset = null;
    stopPatternPoll();
    for (const m of S.pinMeta) {
      m.value = 0;
      m.lastChangeMs = null;
      m.edges = 0;
    }
    for (const h of history) h.clear();
  }

  async function writeOutputsWord(values: number, mask: number) {
    await invoke("write_outputs", { values: values >>> 0, mask: mask >>> 0 });
    S.outputs = (values & mask) | (S.outputs & ~mask);
    S.outputs >>>= 0;
    applyPinValues(S.outputs, "output", S._pausedAt ?? nowStreamT());
    bump("pins");
  }

  // The UI strip models the map as one split point (out_base = 0,
  // in_base = out_count), which matches the device default layout.
  function applyWireMap(map: WirePinMap) {
    S.splitIndex = map.out_count;
    S.pullDefault = map.pull;
    S.mapFlags = map.flags;
    for (let gp = 0; gp < NUM_PINS; gp++) {
      S.pinMeta[gp].pull = gpDir(gp) === "input" ? map.pull : "—";
    }
    S.mapApplied = true;
  }

  // ====== ACTIONS ======
  const actions = {
    versions,
    snap,
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    get: () => S,
    bump,
    gpDir,
    history: (gp: number) => history[gp],

    startLoop() {
      if (S._running) return;
      S._running = true;
      S._t0 = performance.now();
      installListeners();
      const tick = () => {
        if (!S._running) return;
        if (S.connStatus === "connected") {
          if (S.recording) S.streamT = nowStreamT();
          bump("sim");
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },

    async scan() {
      S.scanning = true;
      bump("conn");
      // A webview reload leaves the backend holding the previous port,
      // which makes that device probe as "busy" and vanish from the
      // list; release any stale connection before discovery.
      if (S.connStatus === "disconnected" && tauriAvailable) {
        try {
          await invoke("disconnect");
        } catch {
          /* nothing to release */
        }
      }
      // Discovery probes use their own short-lived transports, so the
      // traffic hook can't see them; summarize the scan here instead.
      log("sent", "discover");
      try {
        const devices = await invoke<WireDeviceInfo[]>("discover");
        S.devices = devices.map((d) => ({
          uid: d.uid,
          num: d.device_number,
          port: d.port,
          fw: d.version,
        }));
        if (!S.selectedUid && S.devices[0]) S.selectedUid = S.devices[0].uid;
        log("received", `OK ${S.devices.length} devices`);
      } catch (e) {
        S.devices = [];
        logError("scan", e);
      }
      S.scanning = false;
      bump("conn");
    },

    select(uid: string) {
      S.selectedUid = uid;
      bump("conn");
    },

    async connect(uid: string | null) {
      const dev = S.devices.find((d) => d.uid === uid) || S.devices[0];
      if (!dev || S.connStatus === "connecting") return;
      S.selectedUid = dev.uid;
      S.connStatus = "connecting";
      bump("conn");
      try {
        await invoke<WireDeviceInfo>("connect", { port: dev.port });
        const version = await invoke<WireVersionInfo>("get_version");
        const caps = await invoke<WireCapabilities>("get_caps");
        const map = await invoke<WirePinMap>("map_get");
        S.version = {
          fw: `${version.major}.${version.minor}.${version.patch}`,
          proto: String(version.protocol_version),
        };
        S.capabilities = {
          pins: caps.max_dio,
          // The FW services at most this many input channels regardless of
          // the pin map; ts arm masks beyond it are BAD_PARAM.
          inCount: caps.in_count,
          maxPattern: caps.max_pattern_steps,
          tsDepth: caps.ts_ring_events,
          // System clock is not reported by `caps` (ts_resolution_ns is the
          // 40 ns phase step); 125 MHz is the device constant from the spec.
          clockMhz: 125,
          sync: (caps.features & 1) !== 0,
        };
        applyWireMap(map);
        S.connStatus = "connected";
        S.connectedUid = dev.uid;
        S._t0 = performance.now();
        S.streamT = 0;
        S._pausedAt = null;
        S._tsOffset = null;
        await invoke("subscribe", { enable: S.subscribed });
        const io = await invoke<WireIoState>("read_state");
        S.inputs = io.inputs >>> 0;
        S.outputs = io.outputs >>> 0;
        // Initialize pin levels without counting the boot snapshot as edges.
        for (let gp = 0; gp < NUM_PINS; gp++) {
          const isIn = gpDir(gp) === "input";
          const c = isIn ? gp - S.splitIndex : gp;
          S.pinMeta[gp].value = ((isIn ? S.inputs : S.outputs) >> c) & 1;
          history[gp].clear(S.pinMeta[gp].value as 0 | 1);
        }
        // default monitor first 8 inputs
        S.monitored = new Set<number>();
        for (let gp = S.splitIndex; gp < NUM_PINS && S.monitored.size < 8; gp++)
          S.monitored.add(gp);
        bump("conn", "pins", "map");
      } catch (e) {
        logError("connect", e);
        S.connStatus = "error";
        resetDeviceState();
        bump("conn", "pins", "pattern", "ts");
        try {
          await invoke("disconnect");
        } catch {
          /* port may not have opened at all */
        }
      }
    },

    async disconnect() {
      try {
        await invoke("disconnect");
      } catch (e) {
        logError("disconnect", e);
      }
      S.connStatus = "disconnected";
      resetDeviceState();
      bump("conn", "pins", "pattern", "ts");
    },

    async readState() {
      if (S.connStatus !== "connected") return;
      try {
        const io = await invoke<WireIoState>("read_state");
        const t = S._pausedAt ?? nowStreamT();
        S.inputs = io.inputs >>> 0;
        S.outputs = io.outputs >>> 0;
        applyPinValues(S.inputs, "input", t);
        applyPinValues(S.outputs, "output", t);
        bump("pins");
      } catch (e) {
        logError("read", e);
      }
    },

    async setSubscribe(on: boolean) {
      try {
        await invoke("subscribe", { enable: on });
        S.subscribed = on;
        bump("conn");
      } catch (e) {
        logError("subscribe", e);
      }
    },

    // outputs
    async toggleOutput(gp: number) {
      if (S.pattern.playState === "running") return;
      try {
        await writeOutputsWord(S.outputs ^ (1 << gp), outputMask());
      } catch (e) {
        logError("write", e);
      }
    },
    async setAllOutputs(v: boolean) {
      if (S.pattern.playState === "running") return;
      try {
        await writeOutputsWord(v ? outputMask() : 0, outputMask());
      } catch (e) {
        logError("write", e);
      }
    },
    async invertOutputs() {
      if (S.pattern.playState === "running") return;
      try {
        await writeOutputsWord(~S.outputs, outputMask());
      } catch (e) {
        logError("write", e);
      }
    },
    async writeHex(v: number) {
      if (S.pattern.playState === "running") return;
      try {
        await writeOutputsWord(v, outputMask());
      } catch (e) {
        logError("write", e);
      }
    },

    // pin map
    setSplit(idx: number) {
      idx = Math.max(0, Math.min(NUM_PINS, idx));
      if (idx === S.splitIndex) return;
      S.splitIndex = idx;
      S.outputs = (S.outputs & outputMask()) >>> 0;
      S.mapApplied = false;
      bump("map", "pins");
    },
    setPull(mode: "up" | "down" | "none") {
      S.pullDefault = mode;
      S.mapApplied = false;
      bump("map");
    },
    setMapFlag(bit: number, on: boolean) {
      S.mapFlags = on ? S.mapFlags | bit : S.mapFlags & ~bit;
      S.mapApplied = false;
      bump("map");
    },
    async applyMap() {
      const map: WirePinMap = {
        version: 1,
        out_base: 0,
        out_count: S.splitIndex,
        in_base: S.splitIndex,
        in_count: NUM_PINS - S.splitIndex,
        pull: S.pullDefault,
        flags: S.mapFlags,
      };
      try {
        await invoke("map_set", { map });
        S.mapApplied = true;
        bump("map", "pins");
      } catch (e) {
        logError("map set", e);
      }
    },
    async saveMap() {
      try {
        await invoke("map_save");
      } catch (e) {
        logError("map save", e);
      }
    },
    async defaultMap() {
      try {
        await invoke("map_default");
        const map = await invoke<WirePinMap>("map_get");
        applyWireMap(map);
        S.outputs = (S.outputs & outputMask()) >>> 0;
        bump("map", "pins");
      } catch (e) {
        logError("map default", e);
      }
    },
    async loadMapToml(path: string) {
      try {
        const map = await invoke<WirePinMap>("map_load_toml", { path });
        applyWireMap(map);
        S.mapApplied = false;
        bump("map", "pins");
        await actions.applyMap();
      } catch (e) {
        logError("map load", e);
      }
    },

    // waveform
    toggleMonitor(gp: number) {
      if (S.monitored.has(gp)) S.monitored.delete(gp);
      else S.monitored.add(gp);
      bump("map");
    },
    setCursor(i: number, t: number) {
      S.cursors[i].t = t;
      bump("sim");
    },
    clearWave() {
      for (let gp = 0; gp < NUM_PINS; gp++)
        history[gp].clear(S.pinMeta[gp].value as 0 | 1);
      bump("sim");
    },
    setRecording(on: boolean) {
      S.recording = on;
      S._pausedAt = on ? null : nowStreamT();
      if (on) S.streamT = nowStreamT();
      bump("sim");
    },
    setWindow(us: number) {
      S.windowUs = us;
      bump("sim");
    },

    // pattern
    async loadPattern(steps: PatternStepUi[]) {
      S.pattern.steps = steps;
      try {
        const accepted = await invoke<number>("pattern_load", {
          steps: steps.map((s) => ({
            out_bits: s.out >>> 0,
            hold_us: s.hold,
          })),
        });
        S.pattern.accepted = accepted;
        S.pattern.playState = "idle";
        S.pattern.curStep = 0;
        S.pattern.loops = 0;
        bump("pattern");
      } catch (e) {
        S.pattern.accepted = null;
        bump("pattern");
        logError("pattern load", e);
      }
    },
    addStep() {
      S.pattern.steps.push({ out: 0, hold: 200 });
      S.pattern.accepted = null;
      bump("pattern");
    },
    removeStep(i: number) {
      S.pattern.steps.splice(i, 1);
      S.pattern.accepted = null;
      bump("pattern");
    },
    updateStep(i: number, patch: Partial<PatternStepUi>) {
      Object.assign(S.pattern.steps[i], patch);
      S.pattern.accepted = null;
      bump("pattern");
    },
    setPatternMode(m: "once" | "loop") {
      S.pattern.mode = m;
      bump("pattern");
    },
    setPatternRepeat(n: number) {
      S.pattern.repeat = n;
      bump("pattern");
    },
    async runPattern() {
      if (S.connStatus !== "connected" || !S.pattern.steps.length) return;
      if (S.pattern.accepted == null) {
        await actions.loadPattern(S.pattern.steps);
        if (S.pattern.accepted == null) return; // upload failed
      }
      try {
        // FW rejects repeat=0 (BAD_PARAM; no infinite mode) — the ∞ field
        // value maps to the u16 maximum instead.
        await invoke("pattern_run", {
          mode: S.pattern.mode,
          repeat:
            S.pattern.mode === "loop"
              ? Math.min(S.pattern.repeat, 65535) || 65535
              : 1,
        });
        S.pattern.playState = "running";
        S.pattern.curStep = 0;
        S.pattern.loops = 0;
        // ensure output pins are on scope
        for (let gp = 0; gp < S.splitIndex; gp++) S.monitored.add(gp);
        startPatternPoll();
        bump("pattern", "map");
      } catch (e) {
        logError("pattern run", e);
      }
    },
    async stopPattern() {
      try {
        await invoke("pattern_stop");
      } catch (e) {
        logError("pattern stop", e);
      }
      S.pattern.playState = "idle";
      stopPatternPoll();
      bump("pattern", "pins");
    },
    async loadPatternToml(path: string) {
      try {
        const payload = await invoke<WirePatternTomlPayload>(
          "pattern_load_toml",
          { path },
        );
        S.pattern.steps = payload.steps.map((s) => ({
          out: s.out_bits >>> 0,
          hold: s.hold_us,
        }));
        S.pattern.accepted = payload.accepted;
        S.pattern.playState = "idle";
        S.pattern.curStep = 0;
        S.pattern.loops = 0;
        bump("pattern");
      } catch (e) {
        logError("pattern load", e);
      }
    },

    // timestamp
    async armTs(mask: number, edge: "rising" | "falling" | "both") {
      try {
        await invoke("ts_arm", { mask: mask >>> 0, mode: edge });
        S.ts.armed = true;
        S.ts.mask = mask >>> 0;
        S.ts.edge = edge;
        S.ts.bufferEst = 0;
        S.ts.result = null;
        bump("ts");
      } catch (e) {
        logError("ts arm", e);
      }
    },
    async disarmTs() {
      try {
        await invoke("ts_disarm");
        S.ts.armed = false;
        bump("ts");
      } catch (e) {
        logError("ts disarm", e);
      }
    },
    async captureTs(reconcile: boolean) {
      try {
        const result = await invoke<WireTsResult>(
          reconcile ? "ts_get_reconciled" : "ts_get",
          { maxEvents: 512 },
        );
        const rows: TsRowUi[] = result.events.map((e, i) => ({
          idx: i,
          inputs: e.inputs,
          rawCount: e.raw_count,
          rawPhase: e.raw_phase,
          syncActive: e.sync_active,
          computedNs: e.timestamp_ns,
          reconciled: e.reconciled,
        }));
        S.ts.result = {
          rows,
          reconciled: result.reconciled,
          overflow: result.overflow,
          span: rows.length
            ? rows[rows.length - 1].computedNs - rows[0].computedNs
            : 0,
        };
        S.ts.bufferEst = 0;
        bump("ts");
      } catch (e) {
        logError("ts get", e);
      }
    },

    // raw repl
    async raw(text: string) {
      if (!text.trim()) return;
      try {
        await invoke<string>("raw_command", { text: text.trim() });
      } catch (e) {
        logError("raw", e);
      }
    },
    clearLog() {
      S.log = [];
      bump("log");
    },
    addLog: log,
  };

  return actions;
}

export const PochiStore = createStore();
export type Store = typeof PochiStore;

// React hook: re-render when any of the named version keys change
export function useStore(keys: VersionKey | VersionKey[]) {
  const k = Array.isArray(keys) ? keys : [keys];
  return useSyncExternalStore(PochiStore.subscribe, () => PochiStore.snap(k));
}

export { fmt };
