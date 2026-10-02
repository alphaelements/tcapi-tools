import { describe, expect, it } from "vitest";
import {
  PIN_MAP_DEFAULT,
  edgeNotify,
  inputChannels,
  outputChannels,
  pullMode,
  withEdgeNotify,
  withPull,
  withSplit,
  type WirePinMap,
} from "./pinmap";
import { VALID_DIO_MASK } from "./pins";

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
});

describe("withSplit", () => {
  it("makes ch0..split-1 outputs and keeps the masks R-M1 consistent", () => {
    const map = withSplit(PIN_MAP_DEFAULT, 2);
    expect(map.direction).toBe(0x3);
    // outputs carry no pull / edge, inputs keep theirs
    expect(map.pull_down).toBe(VALID_DIO_MASK & ~0x3);
    expect(map.edge).toBe(VALID_DIO_MASK & ~0x3);
    expect(map.out_default).toBe(0);
  });

  it("split 25 makes every DIO pin an output", () => {
    const map = withSplit(PIN_MAP_DEFAULT, 25);
    expect(map.direction).toBe(VALID_DIO_MASK);
    expect(map.pull_down).toBe(0);
    expect(map.edge).toBe(0);
  });

  it("split 0 turns outputs back into inputs with the map's current pull and edge setting", () => {
    const outputs = withSplit(withPull(PIN_MAP_DEFAULT, "up"), 4);
    const back = withSplit(outputs, 0);
    expect(back.direction).toBe(0);
    expect(back.pull_up).toBe(VALID_DIO_MASK);
    expect(back.edge).toBe(VALID_DIO_MASK);
  });

  it("drops out_default / out_polarity of pins that stop being outputs", () => {
    const base: WirePinMap = {
      ...withSplit(PIN_MAP_DEFAULT, 4),
      out_default: 0x5,
      out_polarity: 0x8,
    };
    const shrunk = withSplit(base, 2);
    expect(shrunk.out_default).toBe(0x1);
    expect(shrunk.out_polarity).toBe(0);
  });

  it("drops in_polarity of pins that become outputs", () => {
    const base: WirePinMap = { ...PIN_MAP_DEFAULT, in_polarity: 0x6 };
    expect(withSplit(base, 2).in_polarity).toBe(0x4);
  });

  it("rejects a split outside 0-25", () => {
    expect(() => withSplit(PIN_MAP_DEFAULT, 26)).toThrow(RangeError);
    expect(() => withSplit(PIN_MAP_DEFAULT, -1)).toThrow(RangeError);
  });

  it("puts ch23 (GP26) in the output set only at split >= 24", () => {
    expect(withSplit(PIN_MAP_DEFAULT, 23).direction).toBe(0x007fffff);
    expect(withSplit(PIN_MAP_DEFAULT, 24).direction).toBe(0x047fffff);
  });
});

describe("pull mode", () => {
  it("reads uniform pull of the inputs", () => {
    expect(pullMode(PIN_MAP_DEFAULT)).toBe("down");
    expect(pullMode(withPull(PIN_MAP_DEFAULT, "up"))).toBe("up");
    expect(pullMode(withPull(PIN_MAP_DEFAULT, "none"))).toBe("none");
  });

  it("reports mixed when inputs differ", () => {
    const mixed: WirePinMap = { ...PIN_MAP_DEFAULT, pull_up: 0x1, pull_down: VALID_DIO_MASK & ~0x1 };
    expect(pullMode(mixed)).toBe("mixed");
  });

  it("ignores output pins", () => {
    const map = withSplit(withPull(PIN_MAP_DEFAULT, "up"), 3);
    expect(pullMode(map)).toBe("up");
  });

  it("is none when there are no inputs", () => {
    expect(pullMode(withSplit(PIN_MAP_DEFAULT, 25))).toBe("none");
  });

  it("withPull sets pull_up and pull_down exclusively on inputs only", () => {
    const map = withPull(withSplit(PIN_MAP_DEFAULT, 2), "up");
    expect(map.pull_up).toBe(VALID_DIO_MASK & ~0x3);
    expect(map.pull_down).toBe(0);
  });
});

describe("edge notification", () => {
  it("is on when any input has its edge bit", () => {
    expect(edgeNotify(PIN_MAP_DEFAULT)).toBe(true);
    expect(edgeNotify(withEdgeNotify(PIN_MAP_DEFAULT, false))).toBe(false);
  });

  it("withEdgeNotify(true) enables every input and never an output", () => {
    const map = withEdgeNotify(withSplit(withEdgeNotify(PIN_MAP_DEFAULT, false), 2), true);
    expect(map.edge).toBe(VALID_DIO_MASK & ~0x3);
  });
});
