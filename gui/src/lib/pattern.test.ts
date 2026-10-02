import { describe, expect, it } from "vitest";
import {
  PATTERN_TICK_NS,
  holdUsToTicks,
  stepsFromWire,
  stepsToWire,
  ticksToHoldUs,
} from "./pattern";

describe("hold conversion (one tick = 200 ns)", () => {
  it("converts whole and fractional microseconds to ticks", () => {
    expect(PATTERN_TICK_NS).toBe(200);
    expect(holdUsToTicks(1)).toBe(5);
    expect(holdUsToTicks(0.2)).toBe(1);
    expect(holdUsToTicks(200)).toBe(1000);
    expect(holdUsToTicks(0.6)).toBe(3);
  });

  it("rejects holds that are not a multiple of the tick (never rounds)", () => {
    expect(() => holdUsToTicks(0.3)).toThrow(/200 ns/);
    expect(() => holdUsToTicks(1.05)).toThrow(/200 ns/);
  });

  it("rejects zero, negative and non-finite holds", () => {
    expect(() => holdUsToTicks(0)).toThrow(/at least one tick/);
    expect(() => holdUsToTicks(-1)).toThrow();
    expect(() => holdUsToTicks(Number.NaN)).toThrow();
    expect(() => holdUsToTicks(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("rejects holds beyond the u32 tick range", () => {
    expect(() => holdUsToTicks(1e12)).toThrow(/range/);
  });

  it("converts ticks back to microseconds", () => {
    expect(ticksToHoldUs(5)).toBe(1);
    expect(ticksToHoldUs(1)).toBeCloseTo(0.2, 10);
  });
});

describe("step conversion", () => {
  it("packs channel bits into GP bits and holds into ticks", () => {
    const wire = stepsToWire([
      { out: 0b101, hold: 200 },
      { out: 1 << 23, hold: 1 },
    ]);
    expect(wire).toEqual([
      { out_bits: 0x5, hold_ticks: 1000 },
      { out_bits: 0x04000000, hold_ticks: 5 },
    ]);
  });

  it("unpacks wire steps into channel bits and microseconds", () => {
    expect(
      stepsFromWire([
        { out_bits: 0x04000000, hold_ticks: 10 },
        { out_bits: 0x3, hold_ticks: 5 },
      ]),
    ).toEqual([
      { out: 1 << 23, hold: 2 },
      { out: 0x3, hold: 1 },
    ]);
  });

  it("an invalid hold in any step fails the whole conversion", () => {
    expect(() => stepsToWire([{ out: 1, hold: 1 }, { out: 1, hold: 0.1 }])).toThrow();
  });
});
