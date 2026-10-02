import { describe, expect, it } from "vitest";
import {
  PATTERN_TICK_NS,
  formatHold,
  holdTicksFromNs,
  parseHoldInput,
  stepsFromWire,
  stepsToWire,
  ticksToNs,
} from "./pattern";

describe("hold conversion (one tick = 200 ns)", () => {
  it("converts whole nanoseconds to ticks", () => {
    expect(PATTERN_TICK_NS).toBe(200);
    expect(holdTicksFromNs(200)).toBe(1);
    expect(holdTicksFromNs(1000)).toBe(5);
    expect(holdTicksFromNs(200_000)).toBe(1000);
  });

  it("follows the device tick_ns when it is not 200", () => {
    expect(holdTicksFromNs(400, 100)).toBe(4);
    expect(() => holdTicksFromNs(150, 100)).toThrow(/100 ns/);
  });

  it("rejects holds that are not a multiple of the tick (never rounds)", () => {
    expect(() => holdTicksFromNs(300)).toThrow(/200 ns/);
    expect(() => holdTicksFromNs(1050)).toThrow(/200 ns/);
    expect(() => holdTicksFromNs(200.5)).toThrow(/200 ns/);
  });

  it("rejects zero, negative and non-finite holds", () => {
    expect(() => holdTicksFromNs(0)).toThrow(/at least one tick/);
    expect(() => holdTicksFromNs(-200)).toThrow();
    expect(() => holdTicksFromNs(Number.NaN)).toThrow();
    expect(() => holdTicksFromNs(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("rejects holds beyond the u32 tick range", () => {
    expect(() => holdTicksFromNs(1e15)).toThrow(/range/);
    expect(holdTicksFromNs(0xffffffff * 200)).toBe(0xffffffff);
  });

  it("converts ticks to nanoseconds", () => {
    expect(ticksToNs(5)).toBe(1000);
    expect(ticksToNs(1)).toBe(200);
    expect(ticksToNs(3, 100)).toBe(300);
  });

  it("formats a hold as `N ticks (M ns)`", () => {
    expect(formatHold(1)).toBe("1 ticks (200 ns)");
    expect(formatHold(1000)).toBe("1000 ticks (200000 ns)");
    expect(formatHold(5, 100)).toBe("5 ticks (500 ns)");
  });
});

describe("hold input text", () => {
  it("a bare number or `ticks` suffix is a tick count", () => {
    expect(parseHoldInput("1000")).toBe(1000);
    expect(parseHoldInput(" 7 ticks ")).toBe(7);
    expect(parseHoldInput("1 tick")).toBe(1);
  });

  it("ns / us / ms suffixes convert through the tick", () => {
    expect(parseHoldInput("400ns")).toBe(2);
    expect(parseHoldInput("1us")).toBe(5);
    expect(parseHoldInput("1.2 µs")).toBe(6);
    expect(parseHoldInput("2 ms")).toBe(10_000);
  });

  it("rejects text that is not a whole number of ticks", () => {
    expect(() => parseHoldInput("")).toThrow();
    expect(() => parseHoldInput("abc")).toThrow();
    expect(() => parseHoldInput("1.5")).toThrow(/whole/);
    expect(() => parseHoldInput("300ns")).toThrow(/200 ns/);
    expect(() => parseHoldInput("0")).toThrow(/at least one tick/);
    expect(() => parseHoldInput("-3")).toThrow();
    expect(() => parseHoldInput("4294967296")).toThrow(/range/);
  });
});

describe("step conversion", () => {
  it("packs channel bits into GP bits and keeps hold ticks", () => {
    const wire = stepsToWire([
      { out: 0b101, holdTicks: 1000 },
      { out: 1 << 23, holdTicks: 1 },
    ]);
    expect(wire).toEqual([
      { out_bits: 0x5, hold_ticks: 1000 },
      { out_bits: 0x04000000, hold_ticks: 1 },
    ]);
  });

  it("unpacks wire steps into channel bits and ticks", () => {
    expect(
      stepsFromWire([
        { out_bits: 0x04000000, hold_ticks: 10 },
        { out_bits: 0x3, hold_ticks: 5 },
      ]),
    ).toEqual([
      { out: 1 << 23, holdTicks: 10 },
      { out: 0x3, holdTicks: 5 },
    ]);
  });

  it("an invalid hold in any step fails the whole conversion", () => {
    expect(() => stepsToWire([{ out: 1, holdTicks: 1 }, { out: 1, holdTicks: 0 }])).toThrow(/at least one tick/);
    expect(() => stepsToWire([{ out: 1, holdTicks: 1.5 }])).toThrow(/whole/);
    expect(() => stepsToWire([{ out: 1, holdTicks: 2 ** 32 }])).toThrow(/range/);
  });
});
