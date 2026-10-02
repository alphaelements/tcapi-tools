/** Wire-format JSON (snake_case) for the v2 types, matching docs/sdk-api-design.md section 6. */
import { describe, expect, it } from "vitest";
import { fromWire, toWire, toWireJson } from "../src/json.js";
import type { Capabilities, PinMap, TimestampResult } from "../src/types.js";

describe("wire JSON", () => {
  it("TimestampResult has no ns or reconciled field", () => {
    const result: TimestampResult = {
      events: [{ inputs: 1, rawCount: 2, rawPhase: 12, syncActive: true }],
      overflow: false,
    };
    expect(toWire(result)).toEqual({
      events: [{ inputs: 1, raw_count: 2, raw_phase: 12, sync_active: true }],
      overflow: false,
    });
  });

  it("PinMap keys", () => {
    const map: PinMap = {
      flags: 0,
      direction: 15,
      pullUp: 240,
      pullDown: 209714944,
      outDefault: 5,
      outPolarity: 8,
      inPolarity: 256,
      edge: 209715184,
    };
    expect(JSON.parse(toWireJson(map))).toEqual({
      flags: 0,
      direction: 15,
      pull_up: 240,
      pull_down: 209714944,
      out_default: 5,
      out_polarity: 8,
      in_polarity: 256,
      edge: 209715184,
    });
  });

  it("Capabilities keys, including the plain `in`", () => {
    const caps: Capabilities = {
      dio: 25,
      out: 12,
      in: 13,
      tsResNs: 40,
      tickNs: 200,
      patternMax: 256,
      ring: 256,
      features: 3,
    };
    const wire = toWire(caps);
    expect(wire).toEqual({
      dio: 25,
      out: 12,
      in: 13,
      ts_res_ns: 40,
      tick_ns: 200,
      pattern_max: 256,
      ring: 256,
      features: 3,
    });
    expect(fromWire(wire)).toEqual(caps);
  });
});
