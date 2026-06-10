/**
 * Reconcile test vectors ported verbatim from the Rust reference
 * (`sdk/rust/src/reconcile.rs`); all SDKs must produce identical results.
 */
import { describe, expect, it } from "vitest";
import {
  candidates,
  CountExtender,
  groupEvents,
  pairStats,
  reconcile,
  type SourceEvent,
} from "../src/reconcile.js";

function ev(
  device: string,
  channel: string,
  count: number,
  phase: number,
  sync: boolean,
): SourceEvent {
  return {
    device,
    channel,
    inputs: "0x00000001",
    rawCount: count,
    rawPhase: phase,
    syncActive: sync,
  };
}

describe("candidates", () => {
  it("basic", () => {
    expect(candidates(1000, 7)).toEqual([1000280, 999280, 1001280]);
  });
  it("count zero (negative candidate, no crash)", () => {
    expect(candidates(0, 7)).toEqual([280, -720, 1280]);
  });
  it("phase zero / max", () => {
    expect(candidates(1000, 0)).toEqual([1000000, 999000, 1001000]);
    expect(candidates(1000, 24)).toEqual([1000960, 999960, 1001960]);
  });
});

describe("reconcile", () => {
  it("K=1 returns as-is", () => {
    expect(reconcile([[1000, 7]])).toEqual([1000280]);
  });
  it("K=2 no crossing keeps as-is", () => {
    expect(
      reconcile([
        [1000, 7],
        [1000, 9],
      ]),
    ).toEqual([1000280, 1000360]);
  });
  it("K=2 count-1 correction", () => {
    expect(
      reconcile([
        [1001, 2],
        [1000, 2],
      ]),
    ).toEqual([1000080, 1000080]);
  });
  it("K=2 count+1 correction", () => {
    expect(
      reconcile([
        [999, 23],
        [1000, 23],
      ]),
    ).toEqual([1000920, 1000920]);
  });
  it("K=2 both shifted around boundary", () => {
    const r = reconcile([
      [1001, 1],
      [999, 24],
    ]);
    expect(r).toEqual([1000040, 999960]);
    expect(Math.abs(r[0] - r[1])).toBeLessThanOrEqual(100);
  });
  it("K=3 three sources", () => {
    expect(
      reconcile([
        [1000, 1],
        [1001, 1],
        [1000, 2],
      ]),
    ).toEqual([1000040, 1000040, 1000080]);
  });
  it("K=4 four sources", () => {
    expect(
      reconcile([
        [1000, 23],
        [1001, 1],
        [1000, 24],
        [1000, 22],
      ]),
    ).toEqual([1000920, 1001040, 1000960, 1000880]);
    expect(
      reconcile([
        [999, 24],
        [1000, 24],
        [999, 23],
        [999, 22],
      ]),
    ).toEqual([999960, 999960, 999920, 999880]);
  });
  it("ties prefer as-is", () => {
    expect(
      reconcile([
        [1000, 7],
        [1000, 7],
      ]),
    ).toEqual([1000280, 1000280]);
  });
  it("K>8 falls back to as-is", () => {
    const events: Array<[number, number]> = Array.from({ length: 9 }, () => [1000, 7]);
    expect(reconcile(events)).toEqual(Array(9).fill(1000280));
  });
});

describe("CountExtender", () => {
  it("no wrap", () => {
    const ext = new CountExtender();
    expect(ext.extend(100)).toBe(100);
    expect(ext.extend(200)).toBe(200);
    expect(ext.extend(200)).toBe(200);
  });
  it("wraps to high bits", () => {
    const ext = new CountExtender();
    expect(ext.extend(0xfffffff0)).toBe(0xfffffff0);
    expect(ext.extend(5)).toBe(0x1_0000_0005);
    expect(ext.extend(10)).toBe(0x1_0000_000a);
  });
});

describe("groupEvents", () => {
  it("same device 2ch reconciles", () => {
    const groups = groupEvents([
      ev("local", "GP0", 1000, 23, true),
      ev("local", "GP1", 1001, 2, true),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].reconciled).toBe(true);
    expect(groups[0].events).toHaveLength(2);
  });
  it("2 devices 1ch reconciles", () => {
    const groups = groupEvents([
      ev("devA", "GP0", 1000, 17, true),
      ev("devB", "GP0", 1000, 5, true),
    ]);
    expect(groups[0].reconciled).toBe(true);
  });
  it("count gap >= 2 splits groups", () => {
    const groups = groupEvents([
      ev("devA", "GP0", 1000, 17, true),
      ev("devB", "GP0", 1000, 5, true),
      ev("devA", "GP0", 5000, 3, true),
      ev("devB", "GP0", 5001, 0, true),
      ev("devA", "GP0", 9000, 8, true),
    ]);
    expect(groups.map((g) => g.events.length)).toEqual([2, 2, 1]);
    expect(groups[2].reconciled).toBe(false); // K=1
  });
  it("mixed sync_active is uncorrected with warning", () => {
    const groups = groupEvents([
      ev("devA", "GP0", 1000, 17, true),
      ev("devB", "GP0", 1000, 0, false),
    ]);
    expect(groups[0].reconciled).toBe(false);
    expect(groups[0].warning).toContain("mixed sync_active");
  });
  it("timer0 across devices is uncorrected", () => {
    const groups = groupEvents([
      ev("devA", "GP0", 1000, 0, false),
      ev("devB", "GP0", 1000, 0, false),
    ]);
    expect(groups[0].reconciled).toBe(false);
    expect(groups[0].warning).not.toBeNull();
  });
  it("timer0 same device reconciles", () => {
    const groups = groupEvents([
      ev("local", "GP0", 1000, 0, false),
      ev("local", "GP1", 1001, 0, false),
    ]);
    expect(groups[0].reconciled).toBe(true);
  });
  it("basic ns values", () => {
    const groups = groupEvents([
      ev("devA", "GP0", 100, 5, true),
      ev("devB", "GP0", 100, 9, true),
    ]);
    expect(groups[0].approxCount).toBe(100);
    expect(groups[0].reconciledNs).toEqual([100200, 100360]);
  });
});

describe("pairStats", () => {
  it("computes per-pair stats", () => {
    const groups = groupEvents([
      ev("devA", "GP0", 1000, 10, true),
      ev("devB", "GP0", 1000, 5, true),
    ]);
    const stats = pairStats(groups);
    expect(stats).toHaveLength(1);
    expect(stats[0].n).toBe(1);
    expect(stats[0].maxAbsDiffNs).toBe(200);
    expect(stats[0].within500nsPct).toBe(100);
  });
});
