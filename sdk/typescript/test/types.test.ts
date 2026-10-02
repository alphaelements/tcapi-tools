/**
 * Public-API tests for the v2 pin convention helpers and data types
 * (mirrors `sdk/rust/tests/v2_types.rs`).
 */
import { describe, expect, it } from "vitest";
import { ErrorCode, SdkError } from "../src/errors.js";
import {
  DIO_CHANNELS,
  FEAT_RESET,
  FEAT_SYNC,
  PATTERN_TICK_NS,
  PROTO_VERSION,
  VALID_DIO_MASK,
  chToGp,
  checkDioMask,
  defaultPinMap,
  gpToCh,
  hasReset,
  hasSync,
  holdTicksFromNs,
  patternStepHoldNs,
  patternStepToText,
  pinLabel,
  pinMapToSetArgs,
  timestampNs,
  validatePatternStep,
  validatePinMap,
  type Capabilities,
  type PinMap,
} from "../src/types.js";

function invalid(fn: () => unknown, needle?: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SdkError);
    expect((err as SdkError).code).toBe(ErrorCode.InvalidArgument);
    if (needle !== undefined) expect((err as SdkError).message).toContain(needle);
    return;
  }
  throw new Error("expected InvalidArgument");
}

describe("pin convention", () => {
  it("VALID_DIO_MASK is GP0-22, GP26, GP27", () => {
    expect(PROTO_VERSION).toBe(2);
    expect(VALID_DIO_MASK).toBe(0x0c7fffff);
    expect(DIO_CHANNELS).toBe(25);
    for (const gp of [23, 24, 25, 28, 29, 30, 31]) {
      expect((VALID_DIO_MASK & (1 << gp)) >>> 0).toBe(0);
    }
  });

  it("chToGp is identity for ch0-ch22 and relocates ch23/ch24", () => {
    for (let ch = 0; ch <= 22; ch++) expect(chToGp(ch)).toBe(ch);
    expect(chToGp(23)).toBe(26);
    expect(chToGp(24)).toBe(27);
  });

  it("chToGp rejects out-of-range and non-integer channels", () => {
    invalid(() => chToGp(25));
    invalid(() => chToGp(255));
    invalid(() => chToGp(-1));
    invalid(() => chToGp(1.5));
  });

  it("gpToCh inverts chToGp", () => {
    for (let ch = 0; ch < DIO_CHANNELS; ch++) {
      const gp = chToGp(ch);
      expect(gpToCh(gp)).toBe(ch);
      expect((VALID_DIO_MASK & (1 << gp)) >>> 0).not.toBe(0);
    }
  });

  it("gpToCh rejects non-DIO pins", () => {
    for (const gp of [23, 24, 25, 28, 29, 31, 32, 255, -1]) invalid(() => gpToCh(gp));
  });

  it("pinLabel shows GP and channel", () => {
    expect(pinLabel(0)).toBe("GP0 (ch0)");
    expect(pinLabel(22)).toBe("GP22 (ch22)");
    expect(pinLabel(26)).toBe("GP26 (ch23)");
    expect(pinLabel(27)).toBe("GP27 (ch24)");
    invalid(() => pinLabel(23));
  });

  it("checkDioMask rejects bits outside the DIO pins and non-u32 values", () => {
    checkDioMask("m", VALID_DIO_MASK);
    checkDioMask("m", 0);
    invalid(() => checkDioMask("m", 1 << 23), "m");
    invalid(() => checkDioMask("m", 0x1_0000_0000));
    invalid(() => checkDioMask("m", -1));
    invalid(() => checkDioMask("m", 1.5));
  });
});

describe("Capabilities helpers", () => {
  const caps = (features: number): Capabilities => ({
    dio: 25,
    out: 2,
    in: 23,
    tsResNs: 40,
    tickNs: 200,
    patternMax: 256,
    ring: 256,
    features,
  });

  it("feature bits", () => {
    expect(FEAT_SYNC).toBe(1);
    expect(FEAT_RESET).toBe(2);
    expect(hasSync(caps(FEAT_SYNC))).toBe(true);
    expect(hasSync(caps(FEAT_RESET))).toBe(false);
    expect(hasReset(caps(FEAT_RESET))).toBe(true);
    expect(hasReset(caps(0))).toBe(false);
    expect(hasSync(caps(3)) && hasReset(caps(3))).toBe(true);
  });
});

describe("validatePinMap (R-M1)", () => {
  const base = (): PinMap => defaultPinMap();
  const rejects = (map: PinMap, field: string): void =>
    invalid(() => validatePinMap(map), field);

  it("default map is the documented default and valid", () => {
    const m = defaultPinMap();
    expect(m).toEqual({
      flags: 0,
      direction: 0,
      pullUp: 0,
      pullDown: VALID_DIO_MASK,
      outDefault: 0,
      outPolarity: 0,
      inPolarity: 0,
      edge: VALID_DIO_MASK,
    });
    validatePinMap(m);
  });

  it("accepts all outputs and the highest pins", () => {
    validatePinMap({
      ...base(),
      direction: VALID_DIO_MASK,
      pullDown: 0,
      edge: 0,
      outDefault: 0x04000000,
      outPolarity: 0x08000000,
    });
  });

  it("rejects reserved flags", () => {
    for (const flags of [0x01, 0x80, 0xff]) rejects({ ...base(), flags }, "flags");
  });

  it("rejects direction outside the valid mask", () => {
    for (const bit of [23, 24, 25, 28, 31]) {
      rejects(
        { ...base(), direction: (1 << bit) >>> 0, pullDown: 0, edge: 0 },
        "direction",
      );
    }
  });

  it("rejects pull_up outside valid pins or on an output", () => {
    rejects({ ...base(), pullUp: 1 << 23, pullDown: 0 }, "pullUp");
    rejects({ ...base(), direction: 1, pullUp: 1, pullDown: 0, edge: 0 }, "pullUp");
  });

  it("rejects pull_down outside valid pins or on an output", () => {
    rejects({ ...base(), pullDown: 1 << 24 }, "pullDown");
    rejects({ ...base(), direction: 1, pullDown: 1, edge: 0 }, "pullDown");
  });

  it("rejects both pulls on the same pin", () => {
    rejects({ ...base(), pullUp: 0b100, pullDown: VALID_DIO_MASK }, "pullUp & pullDown");
  });

  it("rejects out_default / out_polarity outside direction", () => {
    rejects(
      {
        ...base(),
        direction: 1,
        pullDown: VALID_DIO_MASK & ~1,
        edge: 0,
        outDefault: 0b10,
      },
      "outDefault",
    );
    rejects({ ...base(), outPolarity: 1 }, "outPolarity");
  });

  it("rejects in_polarity / edge outside the input pins", () => {
    rejects({ ...base(), inPolarity: 1 << 25 }, "inPolarity");
    rejects(
      { ...base(), direction: 1, pullDown: VALID_DIO_MASK & ~1, edge: 0, inPolarity: 1 },
      "inPolarity",
    );
    rejects({ ...base(), edge: 1 << 28 }, "edge");
    rejects({ ...base(), direction: 1, pullDown: VALID_DIO_MASK & ~1 }, "edge");
  });

  it("rejects non-integer or oversized fields", () => {
    rejects({ ...base(), flags: 256 }, "flags");
    rejects({ ...base(), direction: -1 }, "direction");
    rejects({ ...base(), edge: 0x1_0000_0000 }, "edge");
    rejects({ ...base(), pullUp: 0.5 }, "pullUp");
  });

  it("pinMapToSetArgs formats the map get payload without the version key", () => {
    const map: PinMap = {
      flags: 0,
      direction: 0x0f,
      pullUp: 0xf0,
      pullDown: 0x0c7fff00,
      outDefault: 5,
      outPolarity: 8,
      inPolarity: 0x100,
      edge: 0x0c7ffff0,
    };
    expect(pinMapToSetArgs(map)).toBe(
      "flags=0x00 dir=0x0000000f pu=0x000000f0 pd=0x0c7fff00 " +
        "def=0x00000005 opol=0x00000008 ipol=0x00000100 edge=0x0c7ffff0",
    );
  });

  it("pinMapToSetArgs refuses an invalid map", () => {
    invalid(() => pinMapToSetArgs({ ...base(), flags: 1 }));
  });
});

describe("pattern step / ticks (R-PT5)", () => {
  it("holdTicksFromNs converts multiples of 200", () => {
    expect(PATTERN_TICK_NS).toBe(200);
    expect(holdTicksFromNs(200)).toBe(1);
    expect(holdTicksFromNs(1000)).toBe(5);
    expect(holdTicksFromNs(200 * 0xffffffff)).toBe(0xffffffff);
  });

  it("never rounds", () => {
    for (const ns of [1, 100, 199, 201, 399, 1001, 0.5]) invalid(() => holdTicksFromNs(ns));
  });

  it("rejects zero, negatives and u32 overflow", () => {
    invalid(() => holdTicksFromNs(0));
    invalid(() => holdTicksFromNs(-200));
    invalid(() => holdTicksFromNs(200 * 0x1_0000_0000));
    invalid(() => holdTicksFromNs(Number.NaN));
  });

  it("step text and hold ns", () => {
    expect(patternStepToText({ outBits: 1, holdTicks: 5 })).toBe("0x1:5");
    expect(patternStepToText({ outBits: 0, holdTicks: 10 })).toBe("0x0:10");
    expect(patternStepHoldNs({ outBits: 1, holdTicks: 5 })).toBe(1000);
    expect(patternStepHoldNs({ outBits: 0, holdTicks: 0xffffffff })).toBe(200 * 0xffffffff);
  });

  it("step validation", () => {
    validatePatternStep({ outBits: 0x0c400001, holdTicks: 0xffffffff });
    invalid(() => validatePatternStep({ outBits: 1, holdTicks: 0 }));
    invalid(() => validatePatternStep({ outBits: 1, holdTicks: 0x1_0000_0000 }));
    invalid(() => patternStepToText({ outBits: 1 << 23, holdTicks: 1 }));
  });
});

describe("timestampNs (R-TS1)", () => {
  it("uses the phase only when sync is active", () => {
    const synced = { inputs: 1, rawCount: 1000, rawPhase: 7, syncActive: true };
    expect(timestampNs(synced, 40)).toBe(1_000_280);
    expect(timestampNs(synced, 50)).toBe(1_000_350);
    // Free-running: the count is TIMER0 microseconds and the phase is not used.
    expect(timestampNs({ inputs: 1, rawCount: 107, rawPhase: 5, syncActive: false }, 40)).toBe(
      107_000,
    );
    expect(timestampNs({ inputs: 1, rawCount: 107, rawPhase: 5, syncActive: false }, 50)).toBe(
      107_000,
    );
  });
});
