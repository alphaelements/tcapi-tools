// ============================================================
// pattern.ts — pattern step conversion between the editor and the wire
//
// The editor shows a step as channel bits and a hold in pattern ticks (with
// the nanosecond equivalent next to it); the device takes physical GP bits
// and `PatternStep { out_bits, hold_ticks }` where one tick is `tick_ns`
// (200 ns, reported by `caps`). Holds are never rounded: a time that is not
// a whole number of ticks is an error, like the SDK's `hold_ticks_from_ns`.
// ============================================================

import { chWordToGp, gpWordToCh } from "./pins";

/// One pattern tick in nanoseconds (the device time base; `caps tick_ns`).
export const PATTERN_TICK_NS = 200;

const MAX_TICKS = 0xffffffff;
const NS_PER_UNIT: Record<string, number> = { ns: 1, us: 1_000, "µs": 1_000, ms: 1_000_000 };
const HOLD_TEXT = /^(\d+(?:\.\d+)?)\s*(ticks?|ns|us|µs|ms)?$/i;

/// Step as serialized by the Rust backend.
export interface WirePatternStep {
  out_bits: number;
  hold_ticks: number;
}

/// Step as edited in the UI.
export interface PatternStepUi {
  /// Output levels, bit = channel.
  out: number;
  /// Hold time in pattern ticks.
  holdTicks: number;
}

function checkTicks(ticks: number): number {
  if (!Number.isInteger(ticks)) {
    throw new RangeError(`hold ${ticks} is not a whole number of ticks`);
  }
  if (ticks < 1) throw new RangeError("hold time must be at least one tick");
  if (ticks > MAX_TICKS) {
    throw new RangeError(`hold ${ticks} ticks exceeds the u32 tick range`);
  }
  return ticks;
}

/// Ticks for a hold of `ns` nanoseconds; errors unless it is an exact
/// multiple of `tickNs` (the SDK's `hold_ticks_from_ns`).
export function holdTicksFromNs(ns: number, tickNs: number = PATTERN_TICK_NS): number {
  if (!Number.isFinite(ns) || ns < 0) {
    throw new RangeError(`hold ${ns} ns is not a valid time`);
  }
  if (!Number.isInteger(ns) || ns % tickNs !== 0) {
    throw new RangeError(`hold ${ns} ns is not a multiple of the ${tickNs} ns pattern tick`);
  }
  return checkTicks(ns / tickNs);
}

export function ticksToNs(ticks: number, tickNs: number = PATTERN_TICK_NS): number {
  return ticks * tickNs;
}

/// `N ticks (M ns)`, the form the editor shows next to a hold.
export function formatHold(ticks: number, tickNs: number = PATTERN_TICK_NS): string {
  return `${ticks} ticks (${ticksToNs(ticks, tickNs)} ns)`;
}

/// Hold field text → ticks. A bare number (or `ticks`) is a tick count;
/// `ns` / `us` / `µs` / `ms` suffixes go through `holdTicksFromNs`.
export function parseHoldInput(text: string, tickNs: number = PATTERN_TICK_NS): number {
  const m = HOLD_TEXT.exec(text.trim());
  if (!m) throw new RangeError(`"${text}" is not a hold time (ticks, or a number with ns / us / ms)`);
  const value = Number.parseFloat(m[1]);
  const unit = (m[2] ?? "ticks").toLowerCase();
  if (unit.startsWith("tick")) return checkTicks(value);
  const ns = Math.round(value * NS_PER_UNIT[unit] * 1e6) / 1e6;
  return holdTicksFromNs(ns, tickNs);
}

export function stepsToWire(steps: PatternStepUi[]): WirePatternStep[] {
  return steps.map((s) => ({
    out_bits: chWordToGp(s.out),
    hold_ticks: checkTicks(s.holdTicks),
  }));
}

export function stepsFromWire(steps: WirePatternStep[]): PatternStepUi[] {
  return steps.map((s) => ({
    out: gpWordToCh(s.out_bits),
    holdTicks: s.hold_ticks,
  }));
}
