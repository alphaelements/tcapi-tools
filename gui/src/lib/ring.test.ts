import { describe, expect, it } from "vitest";
import { EdgeHistory, MAX_EDGES } from "./ring";

describe("EdgeHistory.valueAt", () => {
  it("returns the base value before any edge", () => {
    const h = new EdgeHistory();
    expect(h.valueAt(100)).toBe(0);
    h.clear(1);
    expect(h.valueAt(100)).toBe(1);
  });

  it("returns the level of the last edge at or before t", () => {
    const h = new EdgeHistory();
    h.push(100, 1);
    h.push(200, 0);
    h.push(300, 1);
    expect(h.valueAt(50)).toBe(0);
    expect(h.valueAt(100)).toBe(1); // boundary: edge time counts
    expect(h.valueAt(150)).toBe(1);
    expect(h.valueAt(200)).toBe(0);
    expect(h.valueAt(299.9)).toBe(0);
    expect(h.valueAt(1e9)).toBe(1);
  });

  it("clamps out-of-order pushes to the latest time", () => {
    const h = new EdgeHistory();
    h.push(200, 1);
    h.push(100, 0); // arrives late: clamped to t=200
    expect(h.valueAt(150)).toBe(0); // base value before first edge
    expect(h.valueAt(200)).toBe(0); // last edge at 200 wins
  });
});

describe("EdgeHistory sampler", () => {
  it("matches valueAt for a monotonic sweep", () => {
    const h = new EdgeHistory();
    for (let i = 0; i < 50; i++) h.push(i * 10, (i % 2) as 0 | 1);
    const sample = h.sampler();
    for (let t = -5; t < 520; t += 3.7) {
      expect(sample(t)).toBe(h.valueAt(t));
    }
  });
});

describe("EdgeHistory trimming", () => {
  it("keeps at most MAX_EDGES and preserves the dropped level", () => {
    const h = new EdgeHistory();
    for (let i = 0; i < MAX_EDGES + 10; i++) h.push(i, (i % 2) as 0 | 1);
    expect(h.edgeCount).toBe(MAX_EDGES);
    // value before the oldest kept edge equals the last dropped edge level
    expect(h.valueAt(0)).toBe(((10 - 1) % 2) as 0 | 1);
  });
});

describe("EdgeHistory.clear", () => {
  it("resets edges and adopts the given initial value", () => {
    const h = new EdgeHistory();
    h.push(10, 1);
    h.clear(1);
    expect(h.edgeCount).toBe(0);
    expect(h.valueAt(0)).toBe(1);
  });
});
