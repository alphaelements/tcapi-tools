import { describe, expect, it } from "vitest";
import { fmt, parseHexInput } from "./fmt";

describe("fmt.hex", () => {
  it("formats with 0x prefix, uppercase, 8-digit padding (a v2 wire word)", () => {
    expect(fmt.hex(5)).toBe("0x00000005");
    expect(fmt.hex(0x1fab)).toBe("0x00001FAB");
    expect(fmt.hex(0x0c7fffff)).toBe("0x0C7FFFFF");
  });
  it("treats negative input as unsigned 32-bit", () => {
    expect(fmt.hex(-1, 8)).toBe("0xFFFFFFFF");
  });
  it("honors custom width", () => {
    expect(fmt.hex(0xff, 2)).toBe("0xFF");
  });
});

describe("fmt.us", () => {
  it("keeps sub-millisecond values in µs", () => {
    expect(fmt.us(999)).toBe("999 µs");
  });
  it("switches to ms at 1000 µs", () => {
    expect(fmt.us(1500)).toBe("1.500 ms");
  });
});

describe("fmt.time", () => {
  it("formats HH:MM:SS.mmm with zero padding", () => {
    const d = new Date(2026, 0, 1, 9, 5, 3, 7);
    expect(fmt.time(d)).toBe("09:05:03.007");
  });
});

describe("parseHexInput", () => {
  it("accepts 0x-prefixed and bare hex", () => {
    expect(parseHexInput("0x1F")).toBe(0x1f);
    expect(parseHexInput("1f")).toBe(0x1f);
    expect(parseHexInput("  0XaB ")).toBe(0xab);
  });
  it("rejects empty and malformed input", () => {
    expect(parseHexInput("")).toBeNull();
    expect(parseHexInput("0x")).toBeNull();
    expect(parseHexInput("xyz")).toBeNull();
    expect(parseHexInput("12g")).toBeNull();
    expect(parseHexInput("-5")).toBeNull();
  });
  it("returns unsigned values", () => {
    expect(parseHexInput("ffffffff")).toBe(0xffffffff);
  });
});
