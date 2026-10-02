import { describe, expect, it } from "vitest";
import {
  PIN_MAP_DEFAULT,
  channelConfig,
  inputChannels,
  inputMask,
  outputChannels,
  withChannelFlag,
  withChannelPull,
  withChannelRole,
  type WirePinMap,
} from "./pinmap";
import { VALID_DIO_MASK, chMask } from "./pins";

/// Mirror of the SDK `PinMap::validate` rules (R-M1), so the helpers are
/// checked against the device rules and not against their own output.
function violations(m: WirePinMap): string[] {
  const out: string[] = [];
  const outputs = m.direction >>> 0;
  const inputs = (VALID_DIO_MASK & ~m.direction) >>> 0;
  if (m.flags !== 0) out.push("flags");
  if ((m.direction & ~VALID_DIO_MASK) !== 0) out.push("direction");
  if ((m.pull_up & ~inputs) !== 0) out.push("pull_up");
  if ((m.pull_down & ~inputs) !== 0) out.push("pull_down");
  if ((m.pull_up & m.pull_down) !== 0) out.push("pull_up&pull_down");
  if ((m.out_default & ~outputs) !== 0) out.push("out_default");
  if ((m.out_polarity & ~outputs) !== 0) out.push("out_polarity");
  if ((m.in_polarity & ~inputs) !== 0) out.push("in_polarity");
  if ((m.edge & ~inputs) !== 0) out.push("edge");
  return out;
}

describe("default map (golden map.txt `map default`)", () => {
  it("is every pin an input with pull-down and edge events", () => {
    expect(PIN_MAP_DEFAULT).toEqual({
      flags: 0,
      direction: 0,
      pull_up: 0,
      pull_down: VALID_DIO_MASK,
      out_default: 0,
      out_polarity: 0,
      in_polarity: 0,
      edge: VALID_DIO_MASK,
    });
  });
});

describe("channel lists", () => {
  it("lists output and input channels by direction bit of the GP pin", () => {
    // GP0, GP1 and GP26 (ch23) are outputs.
    const map: WirePinMap = { ...PIN_MAP_DEFAULT, direction: 0x04000003, pull_down: 0x087ffffc, edge: 0x087ffffc };
    expect(outputChannels(map)).toEqual([0, 1, 23]);
    expect(inputChannels(map)).toHaveLength(22);
    expect(inputChannels(map)).not.toContain(23);
  });

  it("inputMask is the DIO complement of the direction mask", () => {
    expect(inputMask(PIN_MAP_DEFAULT)).toBe(VALID_DIO_MASK);
    expect(inputMask({ ...PIN_MAP_DEFAULT, direction: 0x3 })).toBe(VALID_DIO_MASK & ~0x3);
  });
});

describe("channelConfig", () => {
  it("reads one row of the default map", () => {
    expect(channelConfig(PIN_MAP_DEFAULT, 5)).toEqual({
      ch: 5,
      gp: 5,
      role: "input",
      pull: "down",
      outDefault: false,
      outPolarity: false,
      inPolarity: false,
      edge: true,
    });
  });

  it("reads ch23 from bit 26 and ch24 from bit 27", () => {
    const map: WirePinMap = {
      ...PIN_MAP_DEFAULT,
      direction: chMask(23),
      pull_down: VALID_DIO_MASK & ~chMask(23),
      edge: VALID_DIO_MASK & ~chMask(23),
      out_default: chMask(23),
      out_polarity: chMask(23),
      in_polarity: chMask(24),
      pull_up: 0,
    };
    // ch24 is an input with a pull-down; give it pull-up instead.
    const m2 = withChannelPull(map, 24, "up");
    expect(channelConfig(m2, 23)).toMatchObject({
      gp: 26,
      role: "output",
      pull: "none",
      outDefault: true,
      outPolarity: true,
      inPolarity: false,
      edge: false,
    });
    expect(channelConfig(m2, 24)).toMatchObject({
      gp: 27,
      role: "input",
      pull: "up",
      inPolarity: true,
      edge: true,
    });
  });

  it("rejects a channel outside ch0-ch24", () => {
    expect(() => channelConfig(PIN_MAP_DEFAULT, 25)).toThrow(RangeError);
  });
});

describe("withChannelRole", () => {
  it("ch23 -> output sets bit 26 of direction and nothing else on the other bits", () => {
    const map = withChannelRole(PIN_MAP_DEFAULT, 23, "output");
    expect(map.direction).toBe(0x04000000);
    expect(violations(map)).toEqual([]);
  });

  it("an input turned output loses pull, edge and ipol bits", () => {
    const base: WirePinMap = { ...PIN_MAP_DEFAULT, in_polarity: 0x4 };
    const map = withChannelRole(base, 2, "output");
    expect(map.direction).toBe(0x4);
    expect(map.pull_down).toBe(VALID_DIO_MASK & ~0x4);
    expect(map.edge).toBe(VALID_DIO_MASK & ~0x4);
    expect(map.in_polarity).toBe(0);
    expect(violations(map)).toEqual([]);
  });

  it("an output turned input loses def and opol and takes the device default input setting", () => {
    const base: WirePinMap = {
      ...PIN_MAP_DEFAULT,
      direction: 0x3,
      pull_down: VALID_DIO_MASK & ~0x3,
      edge: VALID_DIO_MASK & ~0x3,
      out_default: 0x3,
      out_polarity: 0x2,
    };
    const map = withChannelRole(base, 1, "input");
    expect(map.direction).toBe(0x1);
    expect(map.out_default).toBe(0x1);
    expect(map.out_polarity).toBe(0);
    expect(map.pull_down & 0x2).toBe(0x2);
    expect(map.edge & 0x2).toBe(0x2);
    expect(violations(map)).toEqual([]);
  });

  it("is a no-op when the role does not change", () => {
    expect(withChannelRole(PIN_MAP_DEFAULT, 4, "input")).toEqual(PIN_MAP_DEFAULT);
  });

  it("does not touch the other channels or flags", () => {
    const base: WirePinMap = { ...PIN_MAP_DEFAULT, pull_up: 0x2, pull_down: VALID_DIO_MASK & ~0x2 };
    const map = withChannelRole(base, 0, "output");
    expect(map.pull_up).toBe(0x2);
    expect(map.flags).toBe(0);
  });

  it("rejects a channel outside ch0-ch24", () => {
    expect(() => withChannelRole(PIN_MAP_DEFAULT, 25, "output")).toThrow(RangeError);
  });
});

describe("withChannelPull", () => {
  it("sets pull-up and pull-down exclusively for one input", () => {
    const up = withChannelPull(PIN_MAP_DEFAULT, 3, "up");
    expect(up.pull_up).toBe(0x8);
    expect(up.pull_down).toBe(VALID_DIO_MASK & ~0x8);
    const none = withChannelPull(up, 3, "none");
    expect(none.pull_up).toBe(0);
    expect(none.pull_down).toBe(VALID_DIO_MASK & ~0x8);
    const down = withChannelPull(none, 3, "down");
    expect(down.pull_down).toBe(VALID_DIO_MASK);
    expect(violations(up)).toEqual([]);
  });

  it("uses the GP bit of ch24 (bit 27)", () => {
    expect(withChannelPull(PIN_MAP_DEFAULT, 24, "up").pull_up).toBe(0x08000000);
  });

  it("refuses to give an output a pull (R-M1)", () => {
    const map = withChannelRole(PIN_MAP_DEFAULT, 0, "output");
    expect(() => withChannelPull(map, 0, "up")).toThrow(/output/);
  });
});

describe("withChannelFlag", () => {
  it("edge and in_polarity apply to inputs only", () => {
    const off = withChannelFlag(PIN_MAP_DEFAULT, 7, "edge", false);
    expect(off.edge).toBe(VALID_DIO_MASK & ~0x80);
    const ipol = withChannelFlag(PIN_MAP_DEFAULT, 7, "in_polarity", true);
    expect(ipol.in_polarity).toBe(0x80);
    expect(violations(ipol)).toEqual([]);
    const out = withChannelRole(PIN_MAP_DEFAULT, 7, "output");
    expect(() => withChannelFlag(out, 7, "edge", true)).toThrow(/output/);
    expect(() => withChannelFlag(out, 7, "in_polarity", true)).toThrow(/output/);
  });

  it("out_default and out_polarity apply to outputs only", () => {
    const out = withChannelRole(PIN_MAP_DEFAULT, 23, "output");
    const def = withChannelFlag(out, 23, "out_default", true);
    expect(def.out_default).toBe(0x04000000);
    const opol = withChannelFlag(def, 23, "out_polarity", true);
    expect(opol.out_polarity).toBe(0x04000000);
    expect(violations(opol)).toEqual([]);
    expect(() => withChannelFlag(PIN_MAP_DEFAULT, 0, "out_default", true)).toThrow(/input/);
    expect(() => withChannelFlag(PIN_MAP_DEFAULT, 0, "out_polarity", true)).toThrow(/input/);
  });

  it("clearing a flag leaves the other channels alone", () => {
    const out = withChannelRole(withChannelRole(PIN_MAP_DEFAULT, 0, "output"), 1, "output");
    const both = withChannelFlag(withChannelFlag(out, 0, "out_default", true), 1, "out_default", true);
    expect(withChannelFlag(both, 0, "out_default", false).out_default).toBe(0x2);
  });
});

describe("all eight keys round-trip through channel edits", () => {
  it("one channel of every kind produces a valid map that reads back identically", () => {
    let m: WirePinMap = { ...PIN_MAP_DEFAULT };
    m = withChannelRole(m, 0, "output");
    m = withChannelFlag(m, 0, "out_default", true);
    m = withChannelFlag(m, 0, "out_polarity", true);
    m = withChannelRole(m, 23, "output");
    m = withChannelPull(m, 1, "up");
    m = withChannelFlag(m, 2, "in_polarity", true);
    m = withChannelFlag(m, 3, "edge", false);
    expect(violations(m)).toEqual([]);
    expect(m).toEqual({
      flags: 0,
      direction: 0x04000001,
      pull_up: 0x2,
      pull_down: VALID_DIO_MASK & ~0x04000001 & ~0x2,
      out_default: 0x1,
      out_polarity: 0x1,
      in_polarity: 0x4,
      edge: VALID_DIO_MASK & ~0x04000001 & ~0x8,
    });
    expect(channelConfig(m, 1).pull).toBe("up");
    expect(channelConfig(m, 2).inPolarity).toBe(true);
    expect(channelConfig(m, 3).edge).toBe(false);
  });
});
