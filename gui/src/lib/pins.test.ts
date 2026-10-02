import { describe, expect, it } from "vitest";
import {
  DIO_CHANNELS,
  VALID_DIO_MASK,
  chBit,
  chMask,
  chToGp,
  chWordToGp,
  gpLabel,
  gpToCh,
  gpWordToCh,
  pinName,
} from "./pins";

describe("channel / GP mapping (REF-V2 section 4.2)", () => {
  it("maps ch0-ch22 to GP0-GP22 and ch23/ch24 to GP26/GP27", () => {
    expect(chToGp(0)).toBe(0);
    expect(chToGp(22)).toBe(22);
    expect(chToGp(23)).toBe(26);
    expect(chToGp(24)).toBe(27);
  });

  it("rejects channels outside ch0-ch24", () => {
    expect(() => chToGp(25)).toThrow(RangeError);
    expect(() => chToGp(-1)).toThrow(RangeError);
    expect(() => chToGp(1.5)).toThrow(RangeError);
  });

  it("is the inverse of gpToCh for every DIO pin", () => {
    for (let ch = 0; ch < DIO_CHANNELS; ch++) {
      expect(gpToCh(chToGp(ch))).toBe(ch);
    }
  });

  it("rejects GP23-GP25 and GP28 and above", () => {
    for (const gp of [23, 24, 25, 28, 29, 31]) {
      expect(() => gpToCh(gp)).toThrow(RangeError);
    }
  });

  it("VALID_DIO_MASK covers exactly the GP bits of ch0-ch24", () => {
    let mask = 0;
    for (let ch = 0; ch < DIO_CHANNELS; ch++) mask |= 1 << chToGp(ch);
    expect(mask >>> 0).toBe(VALID_DIO_MASK);
    expect(VALID_DIO_MASK).toBe(0x0c7fffff);
  });
});

describe("word conversion", () => {
  it("moves ch23/ch24 bits to GP26/GP27 and back", () => {
    expect(chWordToGp(1 << 23)).toBe(0x04000000);
    expect(chWordToGp(1 << 24)).toBe(0x08000000);
    expect(gpWordToCh(0x04000000)).toBe(1 << 23);
    expect(gpWordToCh(0x08000000)).toBe(1 << 24);
  });

  it("round-trips every channel word of a sample set", () => {
    for (const w of [0, 1, 0x5a5a5a, 0x1ffffff, 0x1000001]) {
      expect(gpWordToCh(chWordToGp(w))).toBe(w);
    }
  });

  it("drops bits that are not DIO pins", () => {
    expect(gpWordToCh(0xffffffff)).toBe(0x1ffffff);
    expect(chWordToGp(0xffffffff)).toBe(VALID_DIO_MASK);
  });
});

describe("single channel access on wire words", () => {
  it("chBit reads the GP bit of a channel", () => {
    expect(chBit(0x04000000, 23)).toBe(1);
    expect(chBit(0x04000000, 1)).toBe(0);
    expect(chBit(0x1, 0)).toBe(1);
    expect(chBit(0x80000000, 22)).toBe(0);
  });

  it("chMask is the wire bit of a channel", () => {
    expect(chMask(3)).toBe(0x8);
    expect(chMask(23)).toBe(0x04000000);
    expect(chMask(24)).toBe(0x08000000);
    expect(() => chMask(25)).toThrow(RangeError);
  });
});

describe("pinName", () => {
  it("is the plain GP label for ch0-ch22 and shows the channel for relocated pins", () => {
    expect(pinName(5)).toBe("GP05");
    expect(pinName(22)).toBe("GP22");
    expect(pinName(23)).toBe("GP26 (ch23)");
    expect(pinName(24)).toBe("GP27 (ch24)");
  });

  it("gpLabel is always the short GP label", () => {
    expect(gpLabel(5)).toBe("GP05");
    expect(gpLabel(23)).toBe("GP26");
    expect(gpLabel(24)).toBe("GP27");
  });
});
