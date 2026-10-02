/**
 * v2 data types and the channel / pin convention (docs/sdk-api-design.md
 * section 2). Mirrors the Rust reference implementation
 * (`sdk/rust/src/types.rs`); the JSON wire format uses snake_case keys
 * (see json.ts).
 *
 * Every bit mask on the wire is a **physical GP bit position**. Logical
 * channels `ch0..=ch24` are a host-side display concept only; use
 * `chToGp`, `gpToCh`, `pinLabel` and `VALID_DIO_MASK` instead of
 * re-deriving bit positions.
 */

import { SdkError } from "./errors.js";

/** The only protocol version this SDK speaks (`version` reports `proto=2`). */
export const PROTO_VERSION = 2;

/** Bit mask of the DIO pins: GP0-GP22, GP26, GP27 (R-P2). */
export const VALID_DIO_MASK = 0x0c7fffff;

/** Number of DIO channels (`ch0..=ch24`). */
export const DIO_CHANNELS = 25;

/** Pattern tick: one `holdTicks` unit in nanoseconds. */
export const PATTERN_TICK_NS = 200;

/** First GP pin that is shifted past the unusable GP23-GP25 (ch23 -> GP26). */
const FIRST_RELOCATED_GP = 26;
/** First channel that is relocated (ch23). */
const FIRST_RELOCATED_CH = 23;
/** Highest DIO GP pin (ch24 -> GP27). */
const LAST_DIO_GP = 27;

const U32_MAX = 0xffffffff;

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= U32_MAX;
}

/** Physical GP pin of logical channel `ch` (ch0-22 -> GP0-22, ch23 -> GP26, ch24 -> GP27). */
export function chToGp(ch: number): number {
  if (!Number.isInteger(ch) || ch < 0 || ch >= DIO_CHANNELS) {
    throw SdkError.invalidArgument(
      `channel ch${ch} is out of range (ch0-ch${DIO_CHANNELS - 1})`,
    );
  }
  return ch < FIRST_RELOCATED_CH ? ch : ch - FIRST_RELOCATED_CH + FIRST_RELOCATED_GP;
}

/** Logical channel of physical GP pin `gp`; throws for non-DIO pins (GP23-GP25, GP28+). */
export function gpToCh(gp: number): number {
  if (Number.isInteger(gp) && gp >= 0 && gp < FIRST_RELOCATED_CH) return gp;
  if (Number.isInteger(gp) && gp >= FIRST_RELOCATED_GP && gp <= LAST_DIO_GP) {
    return gp - FIRST_RELOCATED_GP + FIRST_RELOCATED_CH;
  }
  throw SdkError.invalidArgument(`GP${gp} is not a DIO pin`);
}

/** Display label for physical GP pin `gp`, e.g. `GP26 (ch23)`. */
export function pinLabel(gp: number): string {
  return `GP${gp} (ch${gpToCh(gp)})`;
}

/** Reject a mask that is not a u32 or has bits outside `VALID_DIO_MASK` (R-PIN2). */
export function checkDioMask(name: string, mask: number): void {
  if (!isU32(mask)) {
    throw SdkError.invalidArgument(`${name} ${mask} is not an unsigned 32-bit integer`);
  }
  if (((mask & ~VALID_DIO_MASK) >>> 0) !== 0) {
    throw SdkError.invalidArgument(
      `${name} 0x${hex8(mask)} has bits outside the DIO pins (0x${hex8(VALID_DIO_MASK)})`,
    );
  }
}

/** Zero-padded 8-digit lower-case hex of a u32 (the R-T3 mask form, without `0x`). */
export function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

export interface DeviceInfo {
  uid: string;
  deviceNumber: number | null;
  port: string;
  version: string | null;
}

export interface VersionInfo {
  major: number;
  minor: number;
  patch: number;
  /** Always 2 for a device this SDK accepts. */
  protocolVersion: number;
}

/** `caps` response. Wire keys: `ts_res_ns`, `tick_ns`, `pattern`, `feat`. */
export interface Capabilities {
  /** Number of DIO pins (25). */
  dio: number;
  /** Pins currently configured as outputs. */
  out: number;
  /** Pins currently configured as inputs. */
  in: number;
  /** Timestamp phase resolution in nanoseconds (40). */
  tsResNs: number;
  /** Pattern tick in nanoseconds (200). */
  tickNs: number;
  /** Maximum number of pattern steps. */
  patternMax: number;
  /** Timestamp ring capacity in events. */
  ring: number;
  /** Feature bit mask (`FEAT_*`). */
  features: number;
}

/** `caps.features` bit 0: multi-device clock sync (`sync` commands). */
export const FEAT_SYNC = 0x01;

/** `caps.features` bit 1: reset commands (`pattern reset` / `reset` / `bootsel`). */
export const FEAT_RESET = 0x02;

/** True if bit 0 of `features` (sync capability) is set. */
export function hasSync(caps: Capabilities): boolean {
  return (caps.features & FEAT_SYNC) !== 0;
}

/** True if the device supports `pattern reset` / `reset` / `bootsel`. */
export function hasReset(caps: Capabilities): boolean {
  return (caps.features & FEAT_RESET) !== 0;
}

/** `state` response: input and output levels as physical GP bit masks. */
export interface IoState {
  inputs: number;
  outputs: number;
}

/**
 * v2 pin map: 8 `key=value` fields on the text protocol. All masks are
 * physical GP bits.
 */
export interface PinMap {
  /** Reserved, must be 0 in v2. */
  flags: number;
  /** `dir`: 1 = output. */
  direction: number;
  /** `pu`: pull-up (inputs only, exclusive with `pullDown`). */
  pullUp: number;
  /** `pd`: pull-down (inputs only). */
  pullDown: number;
  /** `def`: initial output level (outputs only). */
  outDefault: number;
  /** `opol`: output polarity inversion (outputs only). */
  outPolarity: number;
  /** `ipol`: input polarity inversion (inputs only). */
  inPolarity: number;
  /** `edge`: inputs watched for `! INPUT` change events. */
  edge: number;
}

/**
 * The device's default map: every pin an input with pull-down and edge
 * events enabled (R-M4).
 */
export function defaultPinMap(): PinMap {
  return {
    flags: 0,
    direction: 0,
    pullUp: 0,
    pullDown: VALID_DIO_MASK,
    outDefault: 0,
    outPolarity: 0,
    inPolarity: 0,
    edge: VALID_DIO_MASK,
  };
}

/** Check every R-M1 rule; the error names the offending field. */
export function validatePinMap(map: PinMap): void {
  const invalid = (msg: string): SdkError => SdkError.invalidArgument(msg);

  if (!Number.isInteger(map.flags) || map.flags < 0 || map.flags > 0xff) {
    throw invalid(`flags ${map.flags} is not a u8`);
  }
  if (map.flags !== 0) {
    throw invalid(`flags 0x${map.flags.toString(16).padStart(2, "0")}: all bits are reserved and must be 0`);
  }
  const masks: Array<[string, number]> = [
    ["direction", map.direction],
    ["pullUp", map.pullUp],
    ["pullDown", map.pullDown],
    ["outDefault", map.outDefault],
    ["outPolarity", map.outPolarity],
    ["inPolarity", map.inPolarity],
    ["edge", map.edge],
  ];
  for (const [name, value] of masks) {
    if (!isU32(value)) throw invalid(`${name} ${value} is not an unsigned 32-bit integer`);
  }

  const outputs = map.direction;
  const inputs = (VALID_DIO_MASK & ~map.direction) >>> 0;
  if (((map.direction & ~VALID_DIO_MASK) >>> 0) !== 0) {
    throw invalid(`direction 0x${hex8(map.direction)} has bits outside the DIO pins`);
  }
  const subset = (name: string, value: number, allowed: number, what: string): void => {
    if (((value & ~allowed) >>> 0) !== 0) {
      throw invalid(`${name} 0x${hex8(value)} has bits that are not ${what}`);
    }
  };
  subset("pullUp", map.pullUp, inputs, "DIO input pins");
  subset("pullDown", map.pullDown, inputs, "DIO input pins");
  const both = (map.pullUp & map.pullDown) >>> 0;
  if (both !== 0) {
    throw invalid(`pullUp & pullDown 0x${hex8(both)}: a pin cannot have both pulls`);
  }
  subset("outDefault", map.outDefault, outputs, "output pins");
  subset("outPolarity", map.outPolarity, outputs, "output pins");
  subset("inPolarity", map.inPolarity, inputs, "DIO input pins");
  subset("edge", map.edge, inputs, "DIO input pins");
}

/**
 * Arguments for `map set`: the eight keys of a `map get` payload without its
 * leading `v=2` (R-M3). Refuses to encode an invalid map.
 */
export function pinMapToSetArgs(map: PinMap): string {
  validatePinMap(map);
  const x = (v: number): string => `0x${hex8(v)}`;
  return (
    `flags=0x${map.flags.toString(16).padStart(2, "0")} ` +
    `dir=${x(map.direction)} pu=${x(map.pullUp)} pd=${x(map.pullDown)} ` +
    `def=${x(map.outDefault)} opol=${x(map.outPolarity)} ipol=${x(map.inPolarity)} ` +
    `edge=${x(map.edge)}`
  );
}

/** One pattern step: output levels held for `holdTicks` pattern ticks. */
export interface PatternStep {
  /** Logical output value (physical GP bits, subset of the direction mask). */
  outBits: number;
  /** Hold time in pattern ticks of `PATTERN_TICK_NS` ns; at least 1. */
  holdTicks: number;
}

/** Check host-side limits: DIO bits only, non-zero u32 hold. */
export function validatePatternStep(step: PatternStep): void {
  checkDioMask("outBits", step.outBits);
  if (!isU32(step.holdTicks)) {
    throw SdkError.invalidArgument(`holdTicks ${step.holdTicks} is not an unsigned 32-bit integer`);
  }
  if (step.holdTicks === 0) {
    throw SdkError.invalidArgument("holdTicks must be at least 1");
  }
}

/** Text form for `pattern add`: `<outBits>:<holdTicks>`, e.g. `0x1:5`. */
export function patternStepToText(step: PatternStep): string {
  validatePatternStep(step);
  return `0x${step.outBits.toString(16)}:${step.holdTicks}`;
}

/**
 * Hold time in nanoseconds (the tick part only; the fixed ~133 ns PIO
 * overhead of each step is not included, R-PT5).
 */
export function patternStepHoldNs(step: PatternStep): number {
  return step.holdTicks * PATTERN_TICK_NS;
}

/**
 * Convert a hold time in nanoseconds to pattern ticks. Only exact multiples
 * of `PATTERN_TICK_NS` are accepted (never rounded); the result must be
 * between 1 and 2^32-1 ticks.
 */
export function holdTicksFromNs(ns: number): number {
  if (!Number.isSafeInteger(ns) || ns < 0) {
    throw SdkError.invalidArgument(`${ns} ns is not a non-negative integer`);
  }
  if (ns % PATTERN_TICK_NS !== 0) {
    throw SdkError.invalidArgument(
      `${ns} ns is not a multiple of the ${PATTERN_TICK_NS} ns pattern tick`,
    );
  }
  const ticks = ns / PATTERN_TICK_NS;
  if (ticks === 0) throw SdkError.invalidArgument("hold time must be at least one tick");
  if (ticks > U32_MAX) throw SdkError.invalidArgument(`${ns} ns exceeds the u32 tick range`);
  return ticks;
}

export type PatternMode = "once" | "loop";

/** `loaded` = pattern data present but not started. */
export type PatternState = "idle" | "loaded" | "running" | "done";

/** `pattern status` response. */
export interface PatternStatus {
  state: PatternState;
  /** Step being output while running, else 0. */
  step: number;
  /** Completed passes. */
  loops: number;
  /** Steps in the pattern buffer. */
  total: number;
}

export type EdgeMode = "rising" | "falling" | "both";

/** `ts status` response. */
export interface TsStatus {
  armed: boolean;
  /** Events waiting in the device ring. */
  pending: number;
  /** The ring overflowed since the last `ts get`. */
  overflow: boolean;
}

/** One captured edge: `in=<inputs> c=<count> p=<phase> s=<sync>`. */
export interface TimestampEvent {
  /** Logical input values within the armed mask (polarity applied). */
  inputs: number;
  rawCount: number;
  rawPhase: number;
  syncActive: boolean;
}

/**
 * Nanosecond timestamp of an event (R-TS1): with sync active
 * `rawCount * 1000 + rawPhase * tsResNs`; free running, `rawCount` is TIMER0
 * microseconds and the phase is not used. Pass `Capabilities.tsResNs`; the SDK
 * has no resolution constant.
 */
export function timestampNs(event: TimestampEvent, tsResNs: number): number {
  const base = event.rawCount * 1000;
  return event.syncActive ? base + event.rawPhase * tsResNs : base;
}

export interface TimestampResult {
  events: TimestampEvent[];
  /** The FW reported a ring overflow since the last `ts get` (events were dropped). */
  overflow: boolean;
}

/**
 * Asynchronous push event from the device (`! ...` lines). The device sends
 * exactly these three; an unrecognised line is logged and discarded by the
 * transport and never reaches a subscriber.
 */
export type PushEvent =
  | { type: "input_change"; inputs: number; timestampUs: number }
  | { type: "pattern_done"; loops: number }
  | { type: "pattern_timeout"; loops: number };

export type SyncRole = "master" | "slave";

export type SyncState = "idle" | "armed" | "master_armed" | "clocking";
