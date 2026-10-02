// ============================================================
// mock-device-core.ts — virtual Pochi-DIO speaking the v2 text protocol
//
// The model behind the browser-only mock device (mock-device.ts). It is a
// text-line device: `execute("map get")` returns the wire lines a firmware
// would answer, so everything the GUI sees from the mock has the exact v2
// wire format. Behaviour is pinned to the golden transcripts
// (`protocol/golden/*.txt`, replayed by mock-device-golden.test.ts), which
// are the single source of truth for v2.
//
// Time is virtual: the owner moves it with `advanceTo` / `advance`. Pattern
// steps, `! PATTERN_DONE` and input timestamps follow that clock, so tests
// are deterministic and the app drives it from the wall clock.
//
// Not modelled (the golden cases that need them are excluded from the replay
// and the app reports them as unsupported): multi-device `sync *`, flash
// write faults, the pattern wall-clock timeout and binary framing.
// ============================================================

import { PIN_MAP_DEFAULT, type WirePinMap } from "./pinmap";
import { VALID_DIO_MASK } from "./pins";

export const FW_VERSION = "0.1.3";
export const PROTO_VERSION = 2;
/// UID of the golden simulator; the app overrides it per mock device.
export const GOLDEN_UID = "0000000000000000";
/// `caps feat`: FEAT_SYNC | FEAT_RESET.
const FEATURES = 0x03;
const DIO = 25;
const TS_RES_NS = 40;
const TICK_NS = 200;
/// Fixed PIO overhead paid by every pattern step (R-PT5).
const STEP_OVERHEAD_NS = 133;
const PATTERN_MAX = 256;
const TS_RING = 256;
const TS_GET_MAX = 85;
const MAX_LINE_BYTES = 256;
const DEVNUM_UNASSIGNED = 255;

export const HELP_LINES: readonly string[] = [
  "  version                                  Get firmware version",
  "  caps                                     Get device capabilities",
  "  info                                     Get device UID and number",
  "  devnum <n>                               Set device number (0-254, 255=clear)",
  "  ping <u32>                               Echo a number",
  "  map get|set|save|default                 Pin map operations",
  "  read                                     Read all inputs",
  "  write <val> <mask>                       Set outputs",
  "  state                                    Get inputs and outputs",
  "  pattern add|run|stop|reset|status        Output pattern operations",
  "  ts arm|disarm|get|status                 Timestamp operations",
  "  subscribe on|off                         Input change events",
  "  sync arm|master|start|stop|disarm|count  Multi-device clock sync",
  "  reset                                    Reboot the device",
  "  bootsel                                  Reboot into the USB bootloader",
  "  help                                     Show this help",
];

/// A request the model deliberately does not implement.
export class UnsupportedCommand extends Error {}

/// Device error answered as `ERR <name>`.
class DeviceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type EdgeMode = "rising" | "falling" | "both";
type PatternState = "idle" | "loaded" | "running" | "done";

interface Step {
  out: number;
  hold: number;
}
interface TsEntry {
  inputs: number;
  count: number;
}

export interface MockDeviceOptions {
  uid?: string;
  /// Map stored in flash at power-up (applied at boot and after `reset`).
  flashMap?: WirePinMap | null;
  /// Initial `devnum` (255 = unassigned).
  devnum?: number;
  /// Wire output pin k to input pin k (rig loopback) instead of leaving
  /// inputs to be driven externally with `driveInputs`.
  loopback?: boolean;
}

function hex8(v: number): string {
  return "0x" + (v >>> 0).toString(16).padStart(8, "0");
}
function hex2(v: number): string {
  return "0x" + (v & 0xff).toString(16).padStart(2, "0");
}

function parseU32(tok: string | undefined): number | null {
  if (tok === undefined || !/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(tok)) return null;
  const v = Number(tok);
  return Number.isSafeInteger(v) && v <= 0xffffffff ? v : null;
}

/// Parse a number or fail with BAD_PARAM.
function u32(tok: string | undefined): number {
  const v = parseU32(tok);
  if (v === null) throw new DeviceError("BAD_PARAM");
  return v;
}

function noArgs(args: string[]): void {
  if (args.length > 0) throw new DeviceError("BAD_PARAM");
}

function bitsOf(mask: number): number[] {
  const bits: number[] = [];
  for (let b = 0; b < 32; b++) if ((mask >>> b) & 1) bits.push(b);
  return bits;
}

function popcount(mask: number): number {
  return bitsOf(mask).length;
}

const MAP_KEYS = ["flags", "dir", "pu", "pd", "def", "opol", "ipol", "edge"] as const;

function parseMapArgs(args: string[]): WirePinMap {
  const vals = new Map<string, number>();
  for (const tok of args) {
    const eq = tok.indexOf("=");
    if (eq <= 0) throw new DeviceError("BAD_PARAM");
    const key = tok.slice(0, eq).toLowerCase();
    const value = u32(tok.slice(eq + 1));
    if (vals.has(key)) throw new DeviceError("BAD_PARAM");
    if (key === "v") {
      if (value !== PROTO_VERSION) throw new DeviceError("BAD_PARAM");
      vals.set(key, value);
    } else if ((MAP_KEYS as readonly string[]).includes(key)) {
      vals.set(key, value);
    } else {
      throw new DeviceError("BAD_PARAM");
    }
  }
  for (const key of MAP_KEYS) if (!vals.has(key)) throw new DeviceError("BAD_PARAM");
  const get = (k: string) => vals.get(k) as number;
  return {
    flags: get("flags"),
    direction: get("dir"),
    pull_up: get("pu"),
    pull_down: get("pd"),
    out_default: get("def"),
    out_polarity: get("opol"),
    in_polarity: get("ipol"),
    edge: get("edge"),
  };
}

/// R-M1: every rule the device checks on `map set`.
function validateMap(m: WirePinMap): void {
  const outputs = m.direction;
  const inputs = (VALID_DIO_MASK & ~m.direction) >>> 0;
  const within = (value: number, allowed: number) => (value & ~allowed) === 0;
  const ok =
    m.flags === 0 &&
    within(m.direction, VALID_DIO_MASK) &&
    within(m.pull_up, inputs) &&
    within(m.pull_down, inputs) &&
    (m.pull_up & m.pull_down) === 0 &&
    within(m.out_default, outputs) &&
    within(m.out_polarity, outputs) &&
    within(m.in_polarity, inputs) &&
    within(m.edge, inputs);
  if (!ok) throw new DeviceError("BAD_MAP");
}

function mapText(m: WirePinMap): string {
  return (
    `v=${PROTO_VERSION} flags=${hex2(m.flags)} dir=${hex8(m.direction)} pu=${hex8(m.pull_up)} ` +
    `pd=${hex8(m.pull_down)} def=${hex8(m.out_default)} opol=${hex8(m.out_polarity)} ` +
    `ipol=${hex8(m.in_polarity)} edge=${hex8(m.edge)}`
  );
}

function parseStep(tok: string): Step {
  const parts = tok.split(":");
  if (parts.length !== 2) throw new DeviceError("BAD_PARAM");
  const out = u32(parts[0]);
  const hold = u32(parts[1]);
  if (hold === 0) throw new DeviceError("BAD_PARAM");
  return { out, hold };
}

export class MockDeviceCore {
  /// Virtual time in nanoseconds.
  nowNs = 0;

  private readonly uid: string;
  private readonly loopback: boolean;
  private flashMap: WirePinMap | null;
  private devnum: number;

  private map: WirePinMap = { ...PIN_MAP_DEFAULT };
  /// Logical output latch (`state out=`).
  private latch = 0;
  /// Physical level of the input pins (raw, DIO bits only).
  private phys = 0;
  private subscribed = false;
  private readonly pending: string[] = [];

  private steps: Step[] = [];
  private patState: PatternState = "idle";
  private patStep = 0;
  private patLoops = 0;
  private patMode: "once" | "loop" = "once";
  private patRepeat = 1;
  private patStepEndNs = 0;

  private tsArmed = false;
  private tsMask = 0;
  private tsMode: EdgeMode = "rising";
  private tsRing: TsEntry[] = [];
  private tsOverflow = false;

  constructor(opts: MockDeviceOptions = {}) {
    this.uid = opts.uid ?? GOLDEN_UID;
    this.loopback = opts.loopback ?? false;
    this.flashMap = opts.flashMap ? { ...opts.flashMap } : null;
    this.devnum = opts.devnum ?? DEVNUM_UNASSIGNED;
    this.boot();
  }

  // ---------------------------------------------------------------- state

  /// Current RAM pin map.
  get currentMap(): WirePinMap {
    return { ...this.map };
  }
  /// Logical output latch.
  get outputs(): number {
    return this.latch;
  }
  /// Logical input word (polarity applied, input pins only).
  get inputs(): number {
    return this.logicalInputs();
  }
  /// Physical level of the output pins (latch XOR opol).
  get physicalOutputs(): number {
    return (this.latch ^ this.map.out_polarity) & this.map.direction & VALID_DIO_MASK;
  }
  /// Map stored in flash, if any.
  get savedMap(): WirePinMap | null {
    return this.flashMap ? { ...this.flashMap } : null;
  }
  get isSubscribed(): boolean {
    return this.subscribed;
  }
  get isTsArmed(): boolean {
    return this.tsArmed;
  }
  get deviceNumber(): number {
    return this.devnum;
  }
  get patternState(): PatternState {
    return this.patState;
  }

  /// Make the next `ts get` report a ring overflow (test hook).
  markTsOverflow(): void {
    this.tsOverflow = true;
  }

  private inputMask(): number {
    return (VALID_DIO_MASK & ~this.map.direction) >>> 0;
  }

  private logicalInputs(): number {
    return ((this.phys ^ this.map.in_polarity) & this.inputMask()) >>> 0;
  }

  /// Power-up / `reset`: RAM state back to the saved map, flash state kept.
  private boot(): void {
    this.subscribed = false;
    this.applyMap(this.flashMap ?? PIN_MAP_DEFAULT);
  }

  // ----------------------------------------------------------- time, pins

  /// Move virtual time to `targetNs`, running pattern steps that end on the
  /// way. Events raised are queued for `takeEvents`.
  advanceTo(targetNs: number): void {
    if (targetNs < this.nowNs) throw new RangeError("virtual time cannot go backwards");
    while (this.patState === "running" && this.patStepEndNs <= targetNs) {
      this.nowNs = this.patStepEndNs;
      this.finishPatternStep();
    }
    this.nowNs = targetNs;
  }

  advance(deltaNs: number): void {
    this.advanceTo(this.nowNs + deltaNs);
  }

  /// Lines pushed by the device since the last call (`! ...`).
  takeEvents(): string[] {
    return this.pending.splice(0);
  }

  /// Drive the physical level of the input pins (bits of non-input pins are
  /// ignored when read). Raises `! INPUT` and timestamp events for the edges.
  driveInputs(word: number): void {
    const before = this.logicalInputs();
    this.phys = (word & VALID_DIO_MASK) >>> 0;
    this.onInputsChanged(before);
  }

  private onInputsChanged(before: number): void {
    const after = this.logicalInputs();
    const changed = (before ^ after) >>> 0;
    if (changed === 0) return;
    const count = Math.floor(this.nowNs / 1000);
    if (this.tsArmed) {
      for (const bit of bitsOf(changed & this.tsMask)) {
        const rising = ((after >>> bit) & 1) === 1;
        const wanted =
          this.tsMode === "both" || (this.tsMode === "rising" ? rising : !rising);
        if (!wanted) continue;
        this.tsRing.push({ inputs: (after & this.tsMask) >>> 0, count });
        if (this.tsRing.length > TS_RING) {
          this.tsRing.shift();
          this.tsOverflow = true;
        }
      }
    }
    if (this.subscribed && (changed & this.map.edge) !== 0) {
      this.pending.push(`! INPUT in=${hex8(after)} t=${count}`);
    }
  }

  /// Rig loopback: the k-th output pin drives the k-th input pin; inputs
  /// without a partner idle at their pull level.
  private refreshLoopback(): void {
    if (!this.loopback) return;
    const outs = bitsOf(this.map.direction);
    const ins = bitsOf(this.inputMask());
    const physOut = this.physicalOutputs;
    let word = 0;
    ins.forEach((pin, k) => {
      const level =
        k < outs.length ? (physOut >>> outs[k]) & 1 : (this.map.pull_up >>> pin) & 1;
      word |= level << pin;
    });
    this.driveInputs(word >>> 0);
  }

  private setLatch(value: number): void {
    this.latch = (value & this.map.direction) >>> 0;
    this.refreshLoopback();
  }

  private applyMap(map: WirePinMap): void {
    // R-M5: replacing the RAM map returns the pattern engine to idle (steps
    // erased) and disarms the timestamp recorder. A role change alone is not
    // an input edge: only the loopback wiring (if any) re-drives the inputs.
    this.map = { ...map };
    this.latch = (map.out_default & map.direction) >>> 0;
    this.steps = [];
    this.patState = "idle";
    this.patStep = 0;
    this.patLoops = 0;
    this.tsArmed = false;
    this.tsRing = [];
    this.tsOverflow = false;
    this.refreshLoopback();
  }

  // -------------------------------------------------------------- pattern

  private stepDurationNs(step: Step): number {
    return step.hold * TICK_NS + STEP_OVERHEAD_NS;
  }

  private finishPatternStep(): void {
    const next = this.patStep + 1;
    if (next < this.steps.length) {
      this.patStep = next;
      this.patStepEndNs += this.stepDurationNs(this.steps[next]);
      this.setLatch(this.steps[next].out);
      return;
    }
    this.patLoops += 1;
    if (this.patMode === "loop" && this.patLoops < this.patRepeat) {
      this.patStep = 0;
      this.patStepEndNs += this.stepDurationNs(this.steps[0]);
      this.setLatch(this.steps[0].out);
      return;
    }
    this.patState = "done";
    this.patStep = 0;
    this.pending.push(`! PATTERN_DONE loops=${this.patLoops}`);
  }

  // -------------------------------------------------------------- execute

  /// Answer one request line with the wire lines of the response (header and
  /// continuation lines). Asynchronous events are queued: see `takeEvents`.
  execute(line: string): string[] {
    if (new TextEncoder().encode(line).length > MAX_LINE_BYTES) {
      return ["ERR LINE_TOO_LONG"];
    }
    try {
      return this.dispatch(line.trim().split(/\s+/).filter(Boolean));
    } catch (e) {
      if (e instanceof DeviceError) return [`ERR ${e.code}`];
      throw e;
    }
  }

  private dispatch(tok: string[]): string[] {
    const cmd = (tok[0] ?? "").toLowerCase();
    const args = tok.slice(1);
    switch (cmd) {
      case "version":
        noArgs(args);
        return [`OK fw=${FW_VERSION} proto=${PROTO_VERSION}`];
      case "caps":
        noArgs(args);
        return [this.caps()];
      case "info":
        noArgs(args);
        return [`OK uid=${this.uid} devnum=${this.devnum}`];
      case "devnum":
        return this.setDevnum(args);
      case "ping":
        if (args.length !== 1) throw new DeviceError("BAD_PARAM");
        return [`OK pong=${u32(args[0])}`];
      case "map":
        return this.mapCommand(args);
      case "read":
        noArgs(args);
        if (this.inputMask() === 0) throw new DeviceError("NO_RESOURCE");
        return [`OK in=${hex8(this.logicalInputs())}`];
      case "write":
        return this.write(args);
      case "state":
        noArgs(args);
        return [`OK in=${hex8(this.logicalInputs())} out=${hex8(this.latch)}`];
      case "pattern":
        return this.patternCommand(args);
      case "ts":
        return this.tsCommand(args);
      case "subscribe":
        return this.subscribe(args);
      case "reset":
        noArgs(args);
        this.boot();
        return ["OK"];
      case "bootsel":
        noArgs(args);
        return ["OK"];
      case "help":
        noArgs(args);
        return [`OK count=${HELP_LINES.length}`, ...HELP_LINES];
      case "sync":
        throw new UnsupportedCommand("sync is not modelled by the mock device");
      default:
        throw new DeviceError("UNKNOWN_CMD");
    }
  }

  private caps(): string {
    const out = popcount(this.map.direction);
    return (
      `OK dio=${DIO} out=${out} in=${DIO - out} ts_res_ns=${TS_RES_NS} tick_ns=${TICK_NS} ` +
      `pattern=${PATTERN_MAX} ring=${TS_RING} feat=${hex8(FEATURES)}`
    );
  }

  private setDevnum(args: string[]): string[] {
    if (args.length !== 1) throw new DeviceError("BAD_PARAM");
    const n = u32(args[0]);
    if (n > DEVNUM_UNASSIGNED) throw new DeviceError("BAD_PARAM");
    this.devnum = n;
    return ["OK"];
  }

  private mapCommand(args: string[]): string[] {
    const sub = (args[0] ?? "").toLowerCase();
    const rest = args.slice(1);
    switch (sub) {
      case "get":
        noArgs(rest);
        return [`OK ${mapText(this.map)}`];
      case "set": {
        const map = parseMapArgs(rest);
        validateMap(map);
        if (this.patState === "running") throw new DeviceError("BUSY");
        this.applyMap(map);
        return ["OK"];
      }
      case "save":
        noArgs(rest);
        this.flashMap = { ...this.map };
        return ["OK"];
      case "default":
        noArgs(rest);
        if (this.patState === "running") throw new DeviceError("BUSY");
        this.applyMap({ ...PIN_MAP_DEFAULT });
        return ["OK"];
      default:
        throw new DeviceError("UNKNOWN_CMD");
    }
  }

  private write(args: string[]): string[] {
    if (args.length !== 2) throw new DeviceError("BAD_PARAM");
    const values = u32(args[0]);
    const mask = u32(args[1]);
    if (this.map.direction === 0) throw new DeviceError("NO_RESOURCE");
    if ((mask & ~this.map.direction) !== 0) throw new DeviceError("BAD_PARAM");
    this.setLatch((this.latch & ~mask) | (values & mask));
    return ["OK"];
  }

  private subscribe(args: string[]): string[] {
    if (args.length !== 1) throw new DeviceError("BAD_PARAM");
    const arg = args[0].toLowerCase();
    if (arg === "off") {
      this.subscribed = false;
      return ["OK"];
    }
    if (arg !== "on") throw new DeviceError("BAD_PARAM");
    if (this.inputMask() === 0) throw new DeviceError("NO_RESOURCE");
    this.subscribed = true;
    return ["OK"];
  }

  // -------------------------------------------------------------- pattern

  private patternCommand(args: string[]): string[] {
    const sub = (args[0] ?? "").toLowerCase();
    const rest = args.slice(1);
    switch (sub) {
      case "add":
        return this.patternAdd(rest);
      case "run":
        return this.patternRun(rest);
      case "stop":
        noArgs(rest);
        if (this.patState !== "running") throw new DeviceError("NOT_RUNNING");
        this.patState = "loaded";
        this.patStep = 0;
        this.patLoops = 0;
        return ["OK"];
      case "reset":
        noArgs(rest);
        this.steps = [];
        this.patState = "idle";
        this.patStep = 0;
        this.patLoops = 0;
        return ["OK"];
      case "status":
        noArgs(rest);
        return [
          `OK state=${this.patState} step=${this.patStep} loops=${this.patLoops} total=${this.steps.length}`,
        ];
      default:
        throw new DeviceError("UNKNOWN_CMD");
    }
  }

  private patternAdd(args: string[]): string[] {
    if (args.length === 0) throw new DeviceError("BAD_PARAM");
    const added = args.map(parseStep);
    if (this.patState === "running") throw new DeviceError("BUSY");
    for (const s of added) {
      if ((s.out & ~this.map.direction) !== 0) throw new DeviceError("BAD_PARAM");
    }
    if (this.steps.length + added.length > PATTERN_MAX) throw new DeviceError("TOO_LONG");
    this.steps.push(...added);
    this.patState = "loaded";
    this.patLoops = 0;
    this.patStep = 0;
    return [`OK total=${this.steps.length}`];
  }

  private patternRun(args: string[]): string[] {
    const mode = (args[0] ?? "").toLowerCase();
    let repeat = 1;
    if (mode === "once") {
      if (args.length > 2) throw new DeviceError("BAD_PARAM");
      if (args.length === 2) repeat = this.repeatArg(args[1]);
    } else if (mode === "loop") {
      if (args.length !== 2) throw new DeviceError("BAD_PARAM");
      repeat = this.repeatArg(args[1]);
    } else {
      throw new DeviceError("BAD_PARAM");
    }
    if (this.patState === "running") throw new DeviceError("BUSY");
    if (this.steps.length === 0) throw new DeviceError("BAD_PARAM");
    this.patMode = mode;
    this.patRepeat = repeat;
    this.patState = "running";
    this.patStep = 0;
    this.patLoops = 0;
    this.patStepEndNs = this.nowNs + this.stepDurationNs(this.steps[0]);
    this.setLatch(this.steps[0].out);
    return ["OK"];
  }

  /// Repeat count: 1-65535.
  private repeatArg(tok: string): number {
    const n = u32(tok);
    if (n < 1 || n > 0xffff) throw new DeviceError("BAD_PARAM");
    return n;
  }

  // ------------------------------------------------------------ timestamp

  private tsCommand(args: string[]): string[] {
    const sub = (args[0] ?? "").toLowerCase();
    const rest = args.slice(1);
    switch (sub) {
      case "arm":
        return this.tsArm(rest);
      case "disarm":
        noArgs(rest);
        this.tsArmed = false;
        this.tsRing = [];
        this.tsOverflow = false;
        return ["OK"];
      case "status":
        noArgs(rest);
        return [
          `OK armed=${this.tsArmed ? 1 : 0} pending=${this.tsRing.length} overflow=${this.tsOverflow ? 1 : 0}`,
        ];
      case "get":
        return this.tsGet(rest);
      default:
        throw new DeviceError("UNKNOWN_CMD");
    }
  }

  private tsArm(args: string[]): string[] {
    if (args.length !== 2) throw new DeviceError("BAD_PARAM");
    const mask = u32(args[0]);
    const mode = args[1].toLowerCase();
    if (mode !== "rising" && mode !== "falling" && mode !== "both") {
      throw new DeviceError("BAD_PARAM");
    }
    if (this.inputMask() === 0) throw new DeviceError("NO_RESOURCE");
    if (mask === 0 || (mask & ~this.inputMask()) !== 0) throw new DeviceError("BAD_PARAM");
    if (this.tsArmed) throw new DeviceError("BUSY");
    this.tsArmed = true;
    this.tsMask = mask;
    this.tsMode = mode;
    this.tsRing = [];
    this.tsOverflow = false;
    return ["OK"];
  }

  private tsGet(args: string[]): string[] {
    if (args.length !== 1) throw new DeviceError("BAD_PARAM");
    const max = u32(args[0]);
    if (max < 1 || max > TS_GET_MAX) throw new DeviceError("BAD_PARAM");
    if (!this.tsArmed) throw new DeviceError("NOT_ARMED");
    const taken = this.tsRing.splice(0, max);
    const overflow = this.tsOverflow ? 1 : 0;
    this.tsOverflow = false;
    return [
      `OK count=${taken.length} overflow=${overflow}`,
      ...taken.map((e) => `  in=${hex8(e.inputs)} c=${e.count} p=0 s=0`),
    ];
  }
}
