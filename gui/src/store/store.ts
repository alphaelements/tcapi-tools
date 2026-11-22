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
import {
  PIN_MAP_DEFAULT,
  channelConfig,
  inputChannels,
  inputMask,
  outputChannels,
  withChannelFlag,
  withChannelPull,
  withChannelRole,
  type ChannelConfig,
  type ChannelFlag,
  type ChannelRole,
  type PullDir,
  type WirePinMap,
} from "../lib/pinmap";
import {
  PATTERN_TICK_NS,
  stepsFromWire,
  stepsToWire,
  type PatternStepUi,
  type WirePatternStep,
} from "../lib/pattern";
import { DIO_CHANNELS, checkDioMask, chBit, chMask } from "../lib/pins";
import { safetyFeatures } from "../lib/features";
import {
  isFailsafeError,
  parseExclusiveError,
  type ExclusiveViolation,
  type FailsafeCause,
  type SafetyConfig,
  type SafetyState,
} from "../lib/safety";

export type { PatternStepUi } from "../lib/pattern";
export type { ExclusiveViolation, SafetyConfig, SafetyState } from "../lib/safety";

/// Number of DIO channels shown by the UI (ch0-ch24).
export const NUM_PINS = DIO_CHANNELS;

/// Hold of a freshly added pattern step: 200 µs at the 200 ns tick.
const DEFAULT_HOLD_TICKS = 1000;

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
  dio: number;
  out: number;
  in: number;
  ts_res_ns: number;
  tick_ns: number;
  pattern_max: number;
  ring: number;
  features: number;
}
interface WireIoState {
  inputs: number;
  outputs: number;
}
interface WirePatternStatus {
  state: "idle" | "loaded" | "running" | "done";
  step: number;
  loops: number;
  total: number;
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
  steps: WirePatternStep[];
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
  | "ui"
  | "safety";

/// State of the host heartbeat that keeps an enabled watchdog fed.
export type HeartbeatStatus = "off" | "running" | "failed";

export interface SafetyUiState {
  /// Last `safety` read (or the one `apply_safety` returned); null until read
  /// or when the device has no safety features.
  state: SafetyState | null;
  /// Exclusive groups of the device (wire masks, in the order they were set).
  groups: number[];
  heartbeat: HeartbeatStatus;
  /// Why the heartbeat stopped (`tcapi://heartbeat-failed`).
  heartbeatError: string | null;
  /// The last `ERR EXCLUSIVE`, shown by pin name until dismissed.
  violation: ExclusiveViolation | null;
  /// Error of the last safety.toml apply: `file:line: message`.
  fileError: string | null;
  /// What the last successful safety.toml apply configured.
  applied: SafetyConfig | null;
}

function freshSafety(): SafetyUiState {
  return {
    state: null,
    groups: [],
    heartbeat: "off",
    heartbeatError: null,
    violation: null,
    fileError: null,
    applied: null,
  };
}

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
    maxPattern: number;
    tsDepth: number;
    /// Pattern tick (`caps tick_ns`): the unit of every step hold.
    tickNs: number;
    /// Timestamp phase step (`caps ts_res_ns`).
    tsResNs: number;
    sync: boolean;
    reset: boolean;
    /// `caps feat=` word; gates the safety UI (lib/features.ts).
    features: number;
  } | null;
  subscribed: boolean;

  // safety
  safety: SafetyUiState;

  // pins (`inputs` / `outputs` are wire words: bit = GP)
  map: WirePinMap;
  pinMeta: PinMeta[];
  inputs: number;
  outputs: number;
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
    playState: "idle" | "running" | "done" | "timed_out";
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
    safety: 0,
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
    safety: freshSafety(),

    map: { ...PIN_MAP_DEFAULT },
    pinMeta,
    inputs: 0,
    outputs: 0,
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

  /// Direction of channel `ch` according to the current map.
  function gpDir(ch: number): "output" | "input" {
    return (S.map.direction & chMask(ch)) !== 0 ? "output" : "input";
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

  function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /// Log a failed command. Two device errors also reach the safety UI: an
  /// exclusive-group violation is kept (and shown by pin name), and a refused
  /// write because of the failsafe latch re-reads the latch, in case the push
  /// event never arrived.
  function logError(context: string, e: unknown): void {
    const message = errorMessage(e);
    log("error", `${context}: ${message}`);
    const violation = parseExclusiveError(message);
    if (violation) {
      S.safety.violation = violation;
      bump("safety");
    }
    if (isFailsafeError(message)) void actions.refreshSafety();
  }

  function nowStreamT(): number {
    return (performance.now() - S._t0) * 1000;
  }

  // Wire words pack one bit per physical GP pin (REF-V2 R-PIN); the UI
  // indexes pins by channel, so every access goes through chBit.
  function applyPinValues(word: number, dir: "input" | "output", t: number) {
    const chans = dir === "output" ? outputChannels(S.map) : inputChannels(S.map);
    for (const ch of chans) {
      const v = chBit(word, ch);
      const m = S.pinMeta[ch];
      if (v !== m.value) {
        m.value = v;
        m.lastChangeMs = t;
        m.edges++;
        history[ch].push(t, v);
      }
    }
  }

  // ---- push event handling (Tauri events from the backend) ----

  let listenersInstalled = false;
  function installListeners() {
    if (listenersInstalled || !tauriAvailable) return;
    listenersInstalled = true;

    void listen<{ direction: LogDirection; line: string }>(
      "tcapi://log",
      (p) => log(p.direction, p.line),
    );

    void listen<{ inputs: number; timestampUs: number }>(
      "tcapi://input",
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

    void listen<{ loops: number }>("tcapi://pattern-done", (p) => {
      S.pattern.playState = "done";
      S.pattern.loops = p.loops;
      stopPatternPoll();
      bump("pattern");
    });

    void listen<{ loops: number }>("tcapi://pattern-timeout", (p) => {
      S.pattern.playState = "timed_out";
      S.pattern.loops = p.loops;
      stopPatternPoll();
      bump("pattern");
    });

    // The device latched the failsafe: it already put the outputs at their
    // defaults and stopped a running pattern without any pattern event.
    void listen<{ cause: FailsafeCause }>("tcapi://failsafe", (p) => {
      onFailsafe(p.cause);
    });

    // The host heartbeat stopped on a failure: the watchdog, if enabled,
    // will trip unless the link recovers.
    void listen<{ message: string }>("tcapi://heartbeat-failed", (p) => {
      S.safety.heartbeat = "failed";
      S.safety.heartbeatError = p.message;
      log("error", `heartbeat: ${p.message}`);
      bump("safety");
    });

    // sync has no GUI yet (not in the mock); surfaced via tcapi://log.
    void listen<{ raw: string }>("tcapi://unknown-event", () => {});
  }

  /// Apply a `! FAILSAFE` push: show the latch at once, then read the real
  /// state and the outputs (now at their defaults) from the device.
  function onFailsafe(cause: FailsafeCause) {
    const prev = S.safety.state;
    S.safety.state = {
      wdog_ms: prev?.wdog_ms ?? 0,
      remaining_ms: 0,
      failsafe: true,
      cause,
      usbsafe: prev?.usbsafe ?? false,
      excl: prev?.excl ?? 0,
    };
    if (S.pattern.playState === "running") {
      S.pattern.playState = "idle";
      stopPatternPoll();
      bump("pattern");
    }
    bump("safety");
    void actions.refreshSafety();
    void actions.readState();
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
          S.pattern.curStep = st.step;
          S.pattern.loops = st.loops;
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

  /// Wire mask of the output pins.
  function outputMask(): number {
    return S.map.direction >>> 0;
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
    S.safety = freshSafety();
    stopPatternPoll();
    for (const m of S.pinMeta) {
      m.value = 0;
      m.lastChangeMs = null;
      m.edges = 0;
    }
    for (const h of history) h.clear();
  }

  async function writeOutputsWord(values: number, mask: number) {
    // The device rejects value bits outside the DIO pins, so send only the
    // masked bits.
    const masked = (values & mask) >>> 0;
    checkDioMask("write mask", mask >>> 0);
    await invoke("write_outputs", { values: masked, mask: mask >>> 0 });
    S.outputs = (masked | (S.outputs & ~mask)) >>> 0;
    applyPinValues(S.outputs, "output", S._pausedAt ?? nowStreamT());
    bump("pins");
  }

  /// Per-pin pull label for tooltips: inputs show their pull, outputs "—".
  function pinPull(map: WirePinMap, ch: number): string {
    const bit = chMask(ch);
    if (map.direction & bit) return "—";
    if (map.pull_up & bit) return "up";
    if (map.pull_down & bit) return "down";
    return "none";
  }

  function applyWireMap(map: WirePinMap) {
    S.map = { ...map };
    for (let ch = 0; ch < NUM_PINS; ch++) {
      S.pinMeta[ch].pull = pinPull(map, ch);
    }
    S.mapApplied = true;
  }

  /// R-M5: a successful `map set` / `map default` returns the device's
  /// pattern engine to idle (steps erased, so the next run re-uploads) and
  /// disarms timestamp capture.
  function mapReplacedOnDevice() {
    stopPatternPoll();
    S.pattern.accepted = null;
    S.pattern.playState = "idle";
    S.pattern.curStep = 0;
    S.pattern.loops = 0;
    S.ts.armed = false;
    S.ts.bufferEst = 0;
  }

  /// Edit the working map; it is only sent on Apply.
  function editMap(map: WirePinMap) {
    S.map = map;
    for (let ch = 0; ch < NUM_PINS; ch++) {
      S.pinMeta[ch].pull = pinPull(map, ch);
    }
    S.mapApplied = false;
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
          pins: caps.dio,
          maxPattern: caps.pattern_max,
          tsDepth: caps.ring,
          tickNs: caps.tick_ns,
          tsResNs: caps.ts_res_ns,
          sync: (caps.features & 0x1) !== 0,
          reset: (caps.features & 0x2) !== 0,
          features: caps.features,
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
        for (let ch = 0; ch < NUM_PINS; ch++) {
          const word = gpDir(ch) === "input" ? S.inputs : S.outputs;
          const level = chBit(word, ch);
          S.pinMeta[ch].value = level;
          history[ch].clear(level);
        }
        // default monitor first 8 inputs
        S.monitored = new Set<number>(inputChannels(S.map).slice(0, 8));
        bump("conn", "pins", "map");
        // A device that kept a watchdog or a latch (the port was reopened
        // without a restart) shows it right away.
        await actions.refreshSafety();
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
    async toggleOutput(ch: number) {
      if (S.pattern.playState === "running") return;
      try {
        await writeOutputsWord(S.outputs ^ chMask(ch), outputMask());
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
    /// Channels configured as outputs / inputs in the working map.
    outputChannels: () => outputChannels(S.map),
    inputChannels: () => inputChannels(S.map),
    /// Wire mask of the input pins (what `ts arm` takes for "all inputs").
    inputMask: () => inputMask(S.map),
    /// Pattern tick of the connected device (the 200 ns default before connect).
    tickNs: () => S.capabilities?.tickNs ?? PATTERN_TICK_NS,
    /// One editor row: everything the working map says about channel `ch`.
    channelConfig: (ch: number): ChannelConfig => channelConfig(S.map, ch),
    setChannelRole(ch: number, role: ChannelRole) {
      const next = withChannelRole(S.map, ch, role);
      if (next === S.map) return;
      editMap(next);
      S.outputs = (S.outputs & outputMask()) >>> 0;
      bump("map", "pins");
    },
    setChannelPull(ch: number, mode: PullDir) {
      editMap(withChannelPull(S.map, ch, mode));
      bump("map");
    },
    setChannelFlag(ch: number, flag: ChannelFlag, on: boolean) {
      editMap(withChannelFlag(S.map, ch, flag, on));
      bump("map");
    },
    async applyMap() {
      try {
        await invoke("map_set", { map: S.map });
        S.mapApplied = true;
        mapReplacedOnDevice();
        bump("map", "pins", "pattern", "ts");
        await actions.readState();
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
        mapReplacedOnDevice();
        bump("map", "pins", "pattern", "ts");
        await actions.readState();
      } catch (e) {
        logError("map default", e);
      }
    },
    async loadMapToml(path: string) {
      try {
        const map = await invoke<WirePinMap>("map_load_toml", { path });
        editMap(map);
        bump("map", "pins");
        await actions.applyMap();
      } catch (e) {
        logError("map load", e);
      }
    },

    // waveform
    toggleMonitor(ch: number) {
      if (S.monitored.has(ch)) S.monitored.delete(ch);
      else S.monitored.add(ch);
      bump("map");
    },
    setCursor(i: number, t: number) {
      S.cursors[i].t = t;
      bump("sim");
    },
    clearWave() {
      for (let ch = 0; ch < NUM_PINS; ch++)
        history[ch].clear(S.pinMeta[ch].value as 0 | 1);
      bump("sim");
    },
    setRecording(on: boolean) {
      S.recording = on;
      S._pausedAt = on ? null : nowStreamT();
      if (on) S.streamT = nowStreamT();
      bump("sim", "ui");
    },
    setWindow(us: number) {
      S.windowUs = us;
      bump("sim", "ui");
    },

    // pattern
    async loadPattern(steps: PatternStepUi[]) {
      S.pattern.steps = steps;
      try {
        const accepted = await invoke<number>("pattern_load", {
          steps: stepsToWire(steps),
        });
        S.pattern.accepted = accepted;
        S.pattern.playState = "idle";
        S.pattern.curStep = 0;
        S.pattern.loops = 0;
        bump("pattern");
      } catch (e) {
        S.pattern.accepted = null;
        bump("pattern");
        logError("pattern upload", e);
      }
    },
    addStep() {
      S.pattern.steps.push({ out: 0, holdTicks: DEFAULT_HOLD_TICKS });
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
        for (const ch of outputChannels(S.map)) S.monitored.add(ch);
        startPatternPoll();
        bump("pattern", "map");
      } catch (e) {
        logError("pattern run", e);
      }
    },
    async stopPattern() {
      if (S.pattern.playState === "running") {
        try {
          await invoke("pattern_stop");
        } catch (e) {
          logError("pattern stop", e);
        }
      }
      S.pattern.playState = "idle";
      stopPatternPoll();
      bump("pattern", "pins");
    },
    async patternReset() {
      try {
        await invoke("pattern_reset");
      } catch (e) {
        logError("pattern reset", e);
      }
      S.pattern.playState = "idle";
      S.pattern.curStep = 0;
      S.pattern.loops = 0;
      S.pattern.accepted = null;
      stopPatternPoll();
      bump("pattern");
    },
    async systemReset() {
      try {
        await invoke("system_reset");
      } catch (e) {
        logError("reset", e);
      }
      S.connStatus = "disconnected";
      resetDeviceState();
      bump("conn", "pattern", "pins", "ts");
    },
    async bootselReset() {
      try {
        await invoke("bootsel_reset");
      } catch (e) {
        logError("bootsel", e);
      }
      S.connStatus = "disconnected";
      resetDeviceState();
      bump("conn", "pattern", "pins", "ts");
    },
    async loadPatternToml(path: string) {
      try {
        const payload = await invoke<WirePatternTomlPayload>(
          "pattern_load_toml",
          { path },
        );
        S.pattern.steps = stepsFromWire(payload.steps);
        S.pattern.accepted = payload.accepted;
        S.pattern.playState = "idle";
        S.pattern.curStep = 0;
        S.pattern.loops = 0;
        bump("pattern");
      } catch (e) {
        logError("pattern toml", e);
      }
    },

    // timestamp
    async armTs(mask: number, edge: "rising" | "falling" | "both") {
      try {
        checkDioMask("ts arm mask", mask >>> 0);
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

    // safety
    /// Which safety controls the connected device offers (`caps feat=`).
    safetyFeatures: () => safetyFeatures(S.capabilities?.features ?? null),

    /// Read the safety state and the exclusive groups from the device.
    async refreshSafety() {
      if (S.connStatus !== "connected") return;
      const feat = safetyFeatures(S.capabilities?.features ?? null);
      try {
        if (feat.watchdog) {
          const st = await invoke<SafetyState>("get_safety");
          S.safety.state = st;
          // A failed heartbeat stays failed until the watchdog is set again;
          // otherwise the heartbeat follows the device's watchdog.
          if (st.wdog_ms === 0) S.safety.heartbeat = "off";
          else if (S.safety.heartbeat === "off") S.safety.heartbeat = "running";
        }
        if (feat.exclusive) {
          S.safety.groups = await invoke<number[]>("excl_get");
        }
      } catch (e) {
        logError("safety", e);
      }
      bump("safety");
    },
    /// `wdog <ms>`: `0` disables; an enabled watchdog starts the heartbeat
    /// in the backend.
    async setWatchdog(ms: number) {
      try {
        await invoke("wdog", { ms });
        S.safety.heartbeat = ms > 0 ? "running" : "off";
        S.safety.heartbeatError = null;
      } catch (e) {
        logError("wdog", e);
      }
      await actions.refreshSafety();
    },
    async setUsbsafe(on: boolean) {
      try {
        await invoke("usbsafe", { on });
      } catch (e) {
        logError("usbsafe", e);
      }
      await actions.refreshSafety();
    },
    /// `failsafe clear`: release the latch. The outputs stay at their
    /// defaults; the caller confirms with the user first.
    async clearFailsafe() {
      try {
        await invoke("failsafe_clear");
      } catch (e) {
        logError("failsafe clear", e);
      }
      await actions.refreshSafety();
    },
    /// `outputs reset`: every output to its default; stops a running pattern.
    /// Always accepted by the device, also while latched.
    async resetOutputs() {
      try {
        await invoke("outputs_reset");
      } catch (e) {
        logError("outputs reset", e);
        return;
      }
      if (S.pattern.playState === "running") {
        S.pattern.playState = "idle";
        stopPatternPoll();
        bump("pattern");
      }
      await actions.readState();
    },
    /// `excl set`: replace all groups; `[]` clears them.
    async setExclusiveGroups(masks: number[]) {
      try {
        if (masks.length === 0) await invoke("excl_clear");
        else await invoke("excl_set", { masks });
      } catch (e) {
        logError("excl", e);
      }
      await actions.refreshSafety();
    },
    /// Evaluate a safety.toml in the backend and make the device equal to it.
    /// A parse error reads `file:line: message` and is shown as is.
    async applySafetyFile(path: string) {
      S.safety.fileError = null;
      bump("safety");
      try {
        const config = await invoke<SafetyConfig>("safety_load_toml", { path });
        const applied = await invoke<SafetyState>("apply_safety", { config });
        S.safety.state = applied;
        S.safety.applied = config;
        S.safety.heartbeat = applied.wdog_ms > 0 ? "running" : "off";
        S.safety.heartbeatError = null;
        log("received", `safety.toml applied: ${path}`);
      } catch (e) {
        S.safety.fileError = errorMessage(e);
        logError("safety.toml", e);
      }
      await actions.refreshSafety();
    },
    dismissViolation() {
      S.safety.violation = null;
      bump("safety");
    },
    dismissFileError() {
      S.safety.fileError = null;
      bump("safety");
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

export const TcapiStore = createStore();
export type Store = typeof TcapiStore;

// React hook: re-render when any of the named version keys change
export function useStore(keys: VersionKey | VersionKey[]) {
  const k = Array.isArray(keys) ? keys : [keys];
  return useSyncExternalStore(TcapiStore.subscribe, () => TcapiStore.snap(k));
}

export { fmt };
