// ============================================================
// pattern.ts — pattern step conversion between the editor and the wire
//
// The editor shows a step as channel bits and a hold in microseconds; the
// device takes physical GP bits and a hold in pattern ticks of 200 ns
// (`PatternStep { out_bits, hold_ticks }`). Holds are never rounded: a value
// that is not a whole number of ticks is an error, like the SDK's
// `hold_ticks_from_ns`.
// ============================================================

import { chWordToGp, gpWordToCh } from "./pins";

/// One pattern tick in nanoseconds (the device time base).
export const PATTERN_TICK_NS = 200;

const NS_PER_US = 1000;
const MAX_TICKS = 0xffffffff;

/// Step as serialized by the Rust backend.
export interface WirePatternStep {
  out_bits: number;
  hold_ticks: number;
}

/// Step as edited in the UI.
export interface PatternStepUi {
  /// Output levels, bit = channel.
  out: number;
  /// Hold time in microseconds.
  hold: number;
}

export function holdUsToTicks(us: number): number {
  if (!Number.isFinite(us) || us < 0) {
    throw new RangeError(`hold ${us} µs is not a valid time`);
  }
  // Work in whole nanoseconds; microsecond inputs have at most three
  // decimals worth of meaning, anything finer cannot be a multiple of 200 ns.
  const ns = Math.round(us * NS_PER_US * 1e6) / 1e6;
  if (!Number.isInteger(ns) || ns % PATTERN_TICK_NS !== 0) {
    throw new RangeError(
      `hold ${us} µs is not a multiple of the ${PATTERN_TICK_NS} ns pattern tick`,
    );
  }
  const ticks = ns / PATTERN_TICK_NS;
  if (ticks === 0) throw new RangeError("hold time must be at least one tick");
  if (ticks > MAX_TICKS) {
    throw new RangeError(`hold ${us} µs exceeds the u32 tick range`);
  }
  return ticks;
}

export function ticksToHoldUs(ticks: number): number {
  return (ticks * PATTERN_TICK_NS) / NS_PER_US;
}

export function stepsToWire(steps: PatternStepUi[]): WirePatternStep[] {
  return steps.map((s) => ({
    out_bits: chWordToGp(s.out),
    hold_ticks: holdUsToTicks(s.hold),
  }));
}

export function stepsFromWire(steps: WirePatternStep[]): PatternStepUi[] {
  return steps.map((s) => ({
    out: gpWordToCh(s.out_bits),
    hold: ticksToHoldUs(s.hold_ticks),
  }));
}
