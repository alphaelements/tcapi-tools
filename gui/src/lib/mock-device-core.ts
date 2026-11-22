// ============================================================
// mock-device-core.ts — virtual Tcapi-DIO speaking the v2 text protocol
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
// `sync *` models a single device's own state machine and sync-relative
// timestamps (protocol/golden/sync.txt); it does not model a real multi-unit
// bus, so there is no `syncEdge()` propagation between two MockDeviceCore
// instances -- a test that wants a slave clocking from a master's edge calls
// `syncEdge()` on the slave directly once the scenario decides a master
// elsewhere on the bus produced one.
//
// The safety functions (docs/30-usb-protocol.md section 12 of the firmware,
// protocol/golden/safety.txt) are modelled too: the watchdog and the failsafe
// latch, exclusive output groups, `outputs reset`, `usbsafe` with a USB link
// model (`setUsbState` / `setDtr`), `rstinfo` and restarts (`reboot`), `pads`.
//
// Not modelled (the golden cases that need them are excluded from the replay
// and the app reports them as unsupported): flash write faults, the pattern
// wall-clock timeout and binary framing.
// ============================================================

import {
  FEAT_EXCL,
  FEAT_OUTRESET,
  FEAT_PADS,
  FEAT_RSTINFO,
  FEAT_USBSAFE,
  FEAT_WDOG,
  FEATURES_ALL,
} from "./features";
import { PIN_MAP_DEFAULT, type WirePinMap } from "./pinmap";
import { VALID_DIO_MASK } from "./pins";

export const FW_VERSION = "0.1.3";
export const PROTO_VERSION = 2;
/// UID of the golden simulator; the app overrides it per mock device.
export const GOLDEN_UID = "0000000000000000";
/// Feature bit each safety command needs; a device without the bit does not
/// know the command (`ERR UNKNOWN_CMD`), like firmware from before the bit.
const COMMAND_FEATURE: Readonly<Record<string, number>> = {
  wdog: FEAT_WDOG,
  safety: FEAT_WDOG,
  failsafe: FEAT_WDOG,
  outputs: FEAT_OUTRESET,
  excl: FEAT_EXCL,
  usbsafe: FEAT_USBSAFE,
  rstinfo: FEAT_RSTINFO,
  pads: FEAT_PADS,
};
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
  "  wdog <ms>                                Set the watchdog timeout (0=off, 100-10000)",
  "  safety                                   Get the safety state",
  "  failsafe clear                           Release the failsafe latch",
  "  outputs reset                            Return all outputs to their defaults",
  "  excl set|clear|get                       Exclusive output groups",
  "  usbsafe on|off                           Failsafe when the USB link is lost",
  "  rstinfo                                  Get the reset cause and uptime",
  "  pads                                     Read the output pad levels",
  "  reset                                    Reboot the device",
  "  bootsel                                  Reboot into the USB bootloader",
  "  help                                     Show this help",
];

/// Smallest / largest enabled watchdog timeout in milliseconds.
const WDOG_MIN_MS = 100;
const WDOG_MAX_MS = 10_000;
/// Most exclusive groups the device holds.
const MAX_EXCLUSIVE_GROUPS = 16;
const NS_PER_MS = 1_000_000;

/// Why the failsafe latch is set (`safety cause=`).
export type FailsafeCause = "none" | "wdog" | "usb";
/// Cause of the last restart (`rstinfo cause=`).
export type ResetCause = "por" | "wdt" | "soft" | "bor" | "other";
/// USB device state seen by the firmware (golden `~ usb`).
export type UsbState = "configured" | "suspend" | "reset" | "unenumerated";

/// A request the model deliberately does not implement.
export class UnsupportedCommand extends Error {}

/// Device error answered as `ERR <name>`.
class DeviceError extends Error {
  /// `data` is the `key=value` tail of the errors that carry some
  /// (`ERR EXCLUSIVE group=<i> mask=0x%08x`).
  constructor(
    readonly code: string,
    readonly data: string = "",
  ) {
    super(code);
  }
}

/// The first exclusive group of `groups` with two or more pins ON in `state`
/// (a logical output word), as the error the device answers; null when the
/// state is allowed.
function exclusiveViolation(state: number, groups: readonly number[]): DeviceError | null {
  const index = groups.findIndex((g) => popcount(state & g) >= 2);
  if (index < 0) return null;
  return new DeviceError("EXCLUSIVE", `group=${index} mask=${hex8(groups[index])}`);
}

type EdgeMode = "rising" | "falling" | "both";
type PatternState = "idle" | "loaded" | "running" | "done";
/// `sync *` state machine (protocol/golden/sync.txt):
///   idle --arm--> slave-armed --sync_edge--> slave-clocking
///   idle --master--> master-armed --start--> master-clocking --stop--> idle
///   disarm: any state -> idle, always OK
type SyncState = "idle" | "slave-armed" | "slave-clocking" | "master-armed" | "master-clocking";

interface Step {
  out: number;
  hold: number;
}
interface TsEntry {
  inputs: number;
  count: number;
  /// 40 ns phase within the microsecond, 0..24; only meaningful while `sync`.
  phase: number;
  /// Whether `count`/`phase` are sync-clock-relative (`s=1`) or wall-clock (`s=0`).
  sync: boolean;
}

export interface MockDeviceOptions {
  uid?: string;
  /// Map stored in flash at power-up (applied at boot and after `reset`).
  flashMap?: WirePinMap | null;
  /// `caps feat=` word (default: every defined bit). Safety commands whose
  /// bit is missing answer `ERR UNKNOWN_CMD`.
  features?: number;
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

  private readonly uidValue: string;
  private readonly loopback: boolean;
  private readonly features: number;
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

  private syncState: SyncState = "idle";
  /// Virtual time (ns) of the sync edge / `sync start` that began the
  /// current clock; only meaningful while `syncState` is a clocking state.
  private syncOriginNs = 0;

  // --- safety (all volatile: a restart clears them) ---
  private wdogMs = 0;
  /// Virtual time of the last request answered `OK` (restarts the watchdog).
  private lastOkNs = 0;
  private failsafe = false;
  private failsafeCause: FailsafeCause = "none";
  private usbsafe = false;
  private groups: number[] = [];

  // --- link and restart bookkeeping ---
  private dtr = true;
  private usbState: UsbState = "configured";
  private resetCause: ResetCause = "por";
  private bootCount = 1;
  private bootNs = 0;

  constructor(opts: MockDeviceOptions = {}) {
    this.uidValue = opts.uid ?? GOLDEN_UID;
    this.loopback = opts.loopback ?? false;
    this.features = opts.features ?? FEATURES_ALL;
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
  /// Device UID (`info uid=`), fixed for the life of this instance.
  get uid(): string {
    return this.uidValue;
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
    this.syncState = "idle";
    this.wdogMs = 0;
    this.failsafe = false;
    this.failsafeCause = "none";
    this.usbsafe = false;
    this.groups = [];
    this.lastOkNs = this.nowNs;
    this.applyMap(this.flashMap ?? PIN_MAP_DEFAULT);
  }

  /// Restart the device with `cause` (the `reset` command, or a restart from
  /// outside): RAM state is lost, flash state (saved map, device number) is
  /// kept, the clock keeps running, the USB link comes back at once.
  reboot(cause: ResetCause): void {
    this.bootCount += 1;
    this.resetCause = cause;
    this.bootNs = this.nowNs;
    this.dtr = true;
    this.usbState = "configured";
    this.pending.length = 0;
    this.boot();
  }

  /// The DTR line of the CDC port (the host opens / closes the port).
  /// Falling DTR switches `subscribe` off; outputs and the watchdog timer are
  /// not affected.
  setDtr(asserted: boolean): void {
    if (this.dtr && !asserted) this.subscribed = false;
    this.dtr = asserted;
  }

  /// The USB device state the firmware sees. Leaving Configured with
  /// `usbsafe on` (after the first enumeration) trips the failsafe.
  setUsbState(state: UsbState): void {
    const wasConfigured = this.usbState === "configured";
    this.usbState = state;
    if (wasConfigured && state !== "configured" && this.usbsafe) this.trip("usb");
  }

  /// Whether pushed lines can reach the host: DTR asserted and Configured.
  private get linkUp(): boolean {
    return this.dtr && this.usbState === "configured";
  }

  /// Queue a pushed `! ...` line for the host (dropped while the link is down).
  private push(line: string): void {
    if (this.linkUp) this.pending.push(line);
  }

  /// Failsafe trip: outputs to `def`, pattern stopped, latch set, event pushed
  /// once. The first cause is kept while latched.
  private trip(cause: "wdog" | "usb"): void {
    if (this.failsafe) return;
    this.safeState();
    this.failsafe = true;
    this.failsafeCause = cause;
    this.push(`! FAILSAFE cause=${cause}`);
  }

  /// `safe_state()`: a running pattern stops (like `pattern stop`, steps stay
  /// loaded, no event) and every output goes to its `def`. Exclusive groups
  /// are not checked: `def` was validated when it was defined.
  private safeState(): void {
    if (this.patState === "running") {
      this.patState = "loaded";
      this.patStep = 0;
      this.patLoops = 0;
    }
    this.setLatch(this.map.out_default);
  }

  /// External sync bus edge (GP28), driven by whatever device on the bus is
  /// currently the master. A slave armed with `sync arm` starts its clock
  /// from this edge; in every other state the edge is ignored.
  syncEdge(): void {
    if (this.syncState !== "slave-armed") return;
    this.syncState = "slave-clocking";
    this.syncOriginNs = this.nowNs;
  }

  // ----------------------------------------------------------- time, pins

  /// Move virtual time to `targetNs`, running pattern steps that end on the
  /// way. Events raised are queued for `takeEvents`.
  advanceTo(targetNs: number): void {
    if (targetNs < this.nowNs) throw new RangeError("virtual time cannot go backwards");
    for (;;) {
      const patternAt = this.patState === "running" ? this.patStepEndNs : Infinity;
      const wdogAt = this.watchdogDeadlineNs();
      const next = Math.min(patternAt, wdogAt);
      if (next > targetNs) break;
      this.nowNs = Math.max(this.nowNs, next);
      // The watchdog trips at the first poll where now - last_ok >= timeout
      // (the boundary is inclusive), before a pattern step due at the same
      // instant is looked at.
      if (wdogAt <= patternAt) this.trip("wdog");
      else this.finishPatternStep();
    }
    this.nowNs = targetNs;
  }

  /// Virtual time at which the watchdog trips, `Infinity` when it cannot
  /// (disabled or already latched).
  private watchdogDeadlineNs(): number {
    if (this.wdogMs === 0 || this.failsafe) return Infinity;
    return this.lastOkNs + this.wdogMs * NS_PER_MS;
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

  /// `c`/`p`/`s` for a timestamp captured at `this.nowNs`: sync-clock-relative
  /// (microseconds and 40 ns phase since the sync edge/start) while a sync
  /// clock is running, wall-clock otherwise.
  private tsClock(): { count: number; phase: number; sync: boolean } {
    if (this.syncState === "slave-clocking" || this.syncState === "master-clocking") {
      const elapsedNs = this.nowNs - this.syncOriginNs;
      const ticks = Math.floor(elapsedNs / TS_RES_NS);
      return { count: Math.floor(elapsedNs / 1000), phase: ticks % 25, sync: true };
    }
    return { count: Math.floor(this.nowNs / 1000), phase: 0, sync: false };
  }

  private onInputsChanged(before: number): void {
    const after = this.logicalInputs();
    const changed = (before ^ after) >>> 0;
    if (changed === 0) return;
    const wallCount = Math.floor(this.nowNs / 1000);
    if (this.tsArmed) {
      const { count, phase, sync } = this.tsClock();
      for (const bit of bitsOf(changed & this.tsMask)) {
        const rising = ((after >>> bit) & 1) === 1;
        const wanted =
          this.tsMode === "both" || (this.tsMode === "rising" ? rising : !rising);
        if (!wanted) continue;
        this.tsRing.push({ inputs: (after & this.tsMask) >>> 0, count, phase, sync });
        if (this.tsRing.length > TS_RING) {
          this.tsRing.shift();
          this.tsOverflow = true;
        }
      }
    }
    if (this.subscribed && (changed & this.map.edge) !== 0) {
      this.push(`! INPUT in=${hex8(after)} t=${wallCount}`);
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
    this.push(`! PATTERN_DONE loops=${this.patLoops}`);
  }

  // -------------------------------------------------------------- execute

  /// Answer one request line with the wire lines of the response (header and
  /// continuation lines). Asynchronous events are queued: see `takeEvents`.
  execute(line: string): string[] {
    if (new TextEncoder().encode(line).length > MAX_LINE_BYTES) {
      return ["ERR LINE_TOO_LONG"];
    }
    try {
      const lines = this.dispatch(line.trim().split(/\s+/).filter(Boolean));
      // Every request answered OK restarts the watchdog timer, at the instant
      // of the response; ERR responses and malformed lines never do.
      if ((lines[0] ?? "").startsWith("OK")) this.lastOkNs = this.nowNs;
      return lines;
    } catch (e) {
      if (e instanceof DeviceError) return [e.data ? `ERR ${e.code} ${e.data}` : `ERR ${e.code}`];
      throw e;
    }
  }

  private dispatch(tok: string[]): string[] {
    const cmd = (tok[0] ?? "").toLowerCase();
    const args = tok.slice(1);
    const needs = COMMAND_FEATURE[cmd];
    if (needs !== undefined && (this.features & needs) === 0) {
      throw new DeviceError("UNKNOWN_CMD");
    }
    switch (cmd) {
      case "version":
        noArgs(args);
        return [`OK fw=${FW_VERSION} proto=${PROTO_VERSION}`];
      case "caps":
        noArgs(args);
        return [this.caps()];
      case "info":
        noArgs(args);
        return [`OK uid=${this.uidValue} devnum=${this.devnum}`];
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
        this.reboot("soft");
        return ["OK"];
      case "bootsel":
        noArgs(args);
        this.safeState();
        return ["OK"];
      case "wdog":
        return this.wdog(args);
      case "safety":
        noArgs(args);
        return [this.safetyLine()];
      case "failsafe":
        return this.failsafeCommand(args);
      case "outputs":
        return this.outputsCommand(args);
      case "excl":
        return this.exclCommand(args);
      case "usbsafe":
        return this.usbsafeCommand(args);
      case "rstinfo":
        noArgs(args);
        return [
          `OK cause=${this.resetCause} uptime_ms=${Math.floor((this.nowNs - this.bootNs) / NS_PER_MS)} ` +
            `boot=${hex8(this.bootCount)}`,
        ];
      case "pads":
        noArgs(args);
        // The pads follow the outputs in the model: the logical read-back of
        // the output pins equals the output state.
        return [`OK out=${hex8(this.latch)} pad=${hex8(this.latch & this.map.direction)}`];
      case "help":
        noArgs(args);
        return [`OK count=${HELP_LINES.length}`, ...HELP_LINES];
      case "sync":
        return this.syncCommand(args);
      default:
        throw new DeviceError("UNKNOWN_CMD");
    }
  }

  private caps(): string {
    const out = popcount(this.map.direction);
    return (
      `OK dio=${DIO} out=${out} in=${DIO - out} ts_res_ns=${TS_RES_NS} tick_ns=${TICK_NS} ` +
      `pattern=${PATTERN_MAX} ring=${TS_RING} feat=${hex8(this.features)}`
    );
  }

  private setDevnum(args: string[]): string[] {
    if (args.length !== 1) throw new DeviceError("BAD_PARAM");
    const n = u32(args[0]);
    if (n > DEVNUM_UNASSIGNED) throw new DeviceError("BAD_PARAM");
    this.devnum = n;
    return ["OK"];
  }

  // --------------------------------------------------------------- safety

  private wdog(args: string[]): string[] {
    if (args.length !== 1) throw new DeviceError("BAD_PARAM");
    const ms = u32(args[0]);
    if (ms !== 0 && (ms < WDOG_MIN_MS || ms > WDOG_MAX_MS)) throw new DeviceError("BAD_PARAM");
    this.wdogMs = ms;
    return ["OK"];
  }

  /// `remaining_ms` is read before this request restarts the timer.
  private safetyLine(): string {
    let remaining = 0;
    if (this.wdogMs !== 0 && !this.failsafe) {
      const leftNs = this.wdogMs * NS_PER_MS - (this.nowNs - this.lastOkNs);
      remaining = Math.max(0, Math.ceil(leftNs / NS_PER_MS));
    }
    return (
      `OK wdog_ms=${this.wdogMs} remaining_ms=${remaining} failsafe=${this.failsafe ? 1 : 0} ` +
      `cause=${this.failsafeCause} usbsafe=${this.usbsafe ? 1 : 0} excl=${this.groups.length}`
    );
  }

  private failsafeCommand(args: string[]): string[] {
    if ((args[0] ?? "").toLowerCase() !== "clear") throw new DeviceError("UNKNOWN_CMD");
    noArgs(args.slice(1));
    // The latch is released; the outputs stay as they are and the timer
    // restarts (every OK does).
    this.failsafe = false;
    this.failsafeCause = "none";
    return ["OK"];
  }

  private outputsCommand(args: string[]): string[] {
    if ((args[0] ?? "").toLowerCase() !== "reset") throw new DeviceError("UNKNOWN_CMD");
    noArgs(args.slice(1));
    // Never refused: not by BUSY, NO_RESOURCE, FAILSAFE nor EXCLUSIVE. The
    // latch is not touched.
    this.safeState();
    return ["OK"];
  }

  private usbsafeCommand(args: string[]): string[] {
    if (args.length !== 1) throw new DeviceError("BAD_PARAM");
    const arg = args[0].toLowerCase();
    if (arg !== "on" && arg !== "off") throw new DeviceError("BAD_PARAM");
    this.usbsafe = arg === "on";
    return ["OK"];
  }

  private exclCommand(args: string[]): string[] {
    const sub = (args[0] ?? "").toLowerCase();
    const rest = args.slice(1);
    switch (sub) {
      case "get":
        noArgs(rest);
        return [
          `OK count=${this.groups.length}`,
          ...this.groups.map((g) => `  mask=${hex8(g)}`),
        ];
      case "clear":
        noArgs(rest);
        if (this.patState === "running") throw new DeviceError("BUSY");
        this.groups = [];
        return ["OK"];
      case "set":
        return this.exclSet(rest);
      default:
        throw new DeviceError("UNKNOWN_CMD");
    }
  }

  private exclSet(args: string[]): string[] {
    if (args.length < 1 || args.length > MAX_EXCLUSIVE_GROUPS) throw new DeviceError("BAD_PARAM");
    const masks = args.map(u32);
    // Each group: at least two pins, all of them outputs.
    for (const m of masks) {
      if (popcount(m) < 2 || (m & ~this.map.direction) !== 0) throw new DeviceError("BAD_PARAM");
    }
    if (this.patState === "running") throw new DeviceError("BUSY");
    // The state the new groups must allow: the map's def (applied without a
    // check by the trip), the current outputs and every loaded pattern step.
    const states = [this.map.out_default & this.map.direction, this.latch];
    for (const step of this.steps) states.push(step.out);
    for (const state of states) {
      const violation = exclusiveViolation(state, masks);
      if (violation) throw violation;
    }
    this.groups = masks;
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
        // Error order (30-usb-protocol.md 12.2 / 12.6): BUSY while a pattern
        // runs, an invalid map or one that drops a group pin (BAD_MAP),
        // FAILSAFE, then a def that violates a group (EXCLUSIVE).
        if (this.patState === "running") throw new DeviceError("BUSY");
        validateMap(map);
        if (this.groups.some((g) => (g & ~map.direction) !== 0)) throw new DeviceError("BAD_MAP");
        if (this.failsafe) throw new DeviceError("FAILSAFE");
        const violation = exclusiveViolation(map.out_default & map.direction, this.groups);
        if (violation) throw violation;
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
        // The all-input default map cannot hold a group: clear them first.
        if (this.groups.length > 0) throw new DeviceError("BAD_MAP");
        if (this.failsafe) throw new DeviceError("FAILSAFE");
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
    // Latched: only an instruction that leaves its target pins at def.
    if (this.failsafe && ((values ^ this.map.out_default) & mask) !== 0) {
      throw new DeviceError("FAILSAFE");
    }
    const next = ((this.latch & ~mask) | (values & mask)) >>> 0;
    const violation = exclusiveViolation(next, this.groups);
    if (violation) throw violation;
    this.setLatch(next);
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
    // One violating step rejects the whole call: nothing is added.
    for (const s of added) {
      const violation = exclusiveViolation(s.out, this.groups);
      if (violation) throw violation;
    }
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
    if (this.failsafe) throw new DeviceError("FAILSAFE");
    // Defence in depth: the buffer was checked when it was loaded.
    for (const s of this.steps) {
      const violation = exclusiveViolation(s.out, this.groups);
      if (violation) throw violation;
    }
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
      ...taken.map((e) => `  in=${hex8(e.inputs)} c=${e.count} p=${e.phase} s=${e.sync ? 1 : 0}`),
    ];
  }

  // ----------------------------------------------------------------- sync

  private syncCommand(args: string[]): string[] {
    const sub = (args[0] ?? "").toLowerCase();
    noArgs(args.slice(1));
    switch (sub) {
      case "arm":
        if (this.syncState !== "idle") throw new DeviceError("SYNC_STATE");
        this.syncState = "slave-armed";
        return ["OK"];
      case "master":
        if (this.syncState !== "idle") throw new DeviceError("SYNC_STATE");
        this.syncState = "master-armed";
        return ["OK"];
      case "start":
        if (this.syncState !== "master-armed") throw new DeviceError("SYNC_STATE");
        this.syncState = "master-clocking";
        this.syncOriginNs = this.nowNs;
        return ["OK"];
      case "stop":
        if (this.syncState !== "master-clocking") throw new DeviceError("SYNC_STATE");
        this.syncState = "idle";
        return ["OK"];
      case "disarm":
        this.syncState = "idle";
        return ["OK"];
      case "count":
        if (this.syncState !== "slave-clocking" && this.syncState !== "master-clocking") {
          throw new DeviceError("SYNC_STATE");
        }
        return [`OK clocks=${Math.floor((this.nowNs - this.syncOriginNs) / 1000)}`];
      default:
        throw new DeviceError("UNKNOWN_CMD");
    }
  }
}
