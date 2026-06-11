// Edge-history ring buffer feeding the waveform renderer.
//
// One buffer per GPIO: a time-ordered list of (t µs, value) edges plus the
// level that held before the first stored edge. The canvas renderer samples
// it pixel-by-pixel with a monotonic cursor (see `sampler`), replacing the
// mock's pure signal-generator functions without touching the drawing code.

/** Edges kept per channel; ~minutes of fast toggling, trimmed from the front. */
export const MAX_EDGES = 20000;

export class EdgeHistory {
  private times: number[] = [];
  private values: number[] = [];
  /** Level in effect before the oldest stored edge. */
  private baseValue = 0;

  /** Record an edge at time `t` (µs). Out-of-order edges are clamped. */
  push(t: number, value: 0 | 1): void {
    const n = this.times.length;
    if (n > 0 && t < this.times[n - 1]) t = this.times[n - 1];
    this.times.push(t);
    this.values.push(value);
    if (this.times.length > MAX_EDGES) {
      const drop = this.times.length - MAX_EDGES;
      this.baseValue = this.values[drop - 1];
      this.times.splice(0, drop);
      this.values.splice(0, drop);
    }
  }

  /** Level at time `t`: the value of the last edge at or before `t`. */
  valueAt(t: number): number {
    const times = this.times;
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? this.baseValue : this.values[lo - 1];
  }

  /**
   * Forward-only sampler for one left-to-right canvas sweep: each call's
   * `t` must be ≥ the previous call's. O(edges) per sweep instead of
   * O(px·log edges).
   */
  sampler(): (t: number) => number {
    let idx = 0;
    return (t: number) => {
      const times = this.times;
      while (idx < times.length && times[idx] <= t) idx++;
      return idx === 0 ? this.baseValue : this.values[idx - 1];
    };
  }

  get edgeCount(): number {
    return this.times.length;
  }

  clear(initialValue: 0 | 1 = 0): void {
    this.times = [];
    this.values = [];
    this.baseValue = initialValue;
  }
}
