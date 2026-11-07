import { describe, expect, it } from "vitest";
import {
  FEAT_EXCL,
  FEAT_OUTRESET,
  FEAT_USBSAFE,
  FEAT_WDOG,
  FEATURES_ALL,
  safetyFeatures,
} from "./features";
import {
  WDOG_MAX_MS,
  WDOG_MIN_MS,
  describeCause,
  groupMask,
  heartbeatIntervalMs,
  isFailsafeError,
  maskPins,
  parseExclusiveError,
  validateWdogInput,
} from "./safety";

describe("safetyFeatures", () => {
  it("offers nothing when not connected or without feature bits", () => {
    for (const f of [null, 0, 0x03]) {
      const s = safetyFeatures(f);
      expect(s.any).toBe(false);
      expect(s.applyFile).toBe(false);
    }
  });

  it("gates each control on its own bit", () => {
    expect(safetyFeatures(FEAT_WDOG)).toMatchObject({ watchdog: true, exclusive: false, any: true });
    expect(safetyFeatures(FEAT_EXCL)).toMatchObject({ exclusive: true, watchdog: false });
    expect(safetyFeatures(FEAT_OUTRESET)).toMatchObject({ outputsReset: true, any: true });
    expect(safetyFeatures(FEAT_USBSAFE)).toMatchObject({ usbsafe: true });
  });

  it("applies a safety.toml only when watchdog, exclusive and usbsafe are all there", () => {
    expect(safetyFeatures(FEAT_WDOG | FEAT_EXCL).applyFile).toBe(false);
    expect(safetyFeatures(FEAT_WDOG | FEAT_EXCL | FEAT_USBSAFE).applyFile).toBe(true);
    expect(safetyFeatures(FEATURES_ALL).applyFile).toBe(true);
  });
});

describe("validateWdogInput", () => {
  it("accepts 0 (off) and the range 100..=10000", () => {
    expect(validateWdogInput("0")).toEqual({ ok: true, ms: 0 });
    expect(validateWdogInput(" 100 ")).toEqual({ ok: true, ms: WDOG_MIN_MS });
    expect(validateWdogInput("10000")).toEqual({ ok: true, ms: WDOG_MAX_MS });
    expect(validateWdogInput("2500")).toEqual({ ok: true, ms: 2500 });
  });

  it("rejects out-of-range, fractional, signed and non-numeric text", () => {
    for (const t of ["", "99", "10001", "1.5", "-100", "abc", "1e3", "0x64", "100ms"]) {
      const r = validateWdogInput(t);
      expect(r.ok, t).toBe(false);
    }
  });
});

describe("heartbeatIntervalMs", () => {
  it("is a quarter of the timeout, at most one second", () => {
    expect(heartbeatIntervalMs(100)).toBe(25);
    expect(heartbeatIntervalMs(2000)).toBe(500);
    expect(heartbeatIntervalMs(10000)).toBe(1000);
  });
});

describe("parseExclusiveError", () => {
  it("reads group and mask from the SDK message", () => {
    expect(
      parseExclusiveError(
        "device error: EXCLUSIVE (exclusive group 1 would be violated, mask 0x0000000c)",
      ),
    ).toEqual({ group: 1, mask: 0xc });
  });

  it("finds it inside a longer message", () => {
    expect(
      parseExclusiveError(
        "write: device error: EXCLUSIVE (exclusive group 0 would be violated, mask 0x0c000003)",
      ),
    ).toEqual({ group: 0, mask: 0x0c000003 });
  });

  it("returns null for other errors and malformed ones", () => {
    expect(parseExclusiveError("device error: BUSY (device is busy)")).toBeNull();
    expect(parseExclusiveError("device error: EXCLUSIVE (broken)")).toBeNull();
    expect(parseExclusiveError("")).toBeNull();
  });
});

describe("isFailsafeError", () => {
  it("recognises the latch error", () => {
    expect(isFailsafeError("device error: FAILSAFE (failsafe latch is set)")).toBe(true);
    expect(isFailsafeError("device error: BUSY (device is busy)")).toBe(false);
  });
});

describe("maskPins / groupMask", () => {
  it("names the pins of a wire mask by GP pin and channel, in channel order", () => {
    expect(maskPins(0xc)).toEqual(["GP2 (ch2)", "GP3 (ch3)"]);
    // GP26 is channel 23.
    expect(maskPins(0x04000001)).toEqual(["GP0 (ch0)", "GP26 (ch23)"]);
  });

  it("ignores bits that are not DIO pins and gives [] for 0", () => {
    expect(maskPins(0)).toEqual([]);
    expect(maskPins(0x01800000)).toEqual([]);
  });

  it("builds a group mask from channels", () => {
    expect(groupMask([2, 3])).toBe(0xc);
    expect(groupMask([0, 23])).toBe(0x04000001);
  });
});

describe("describeCause", () => {
  it("explains each failsafe cause", () => {
    expect(describeCause("wdog")).toMatch(/watchdog/i);
    expect(describeCause("usb")).toMatch(/usb/i);
    expect(describeCause("none")).toBe("");
  });
});
