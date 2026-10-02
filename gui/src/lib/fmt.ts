// Formatting helpers, ported from design-reference store.jsx (`fmt`).

export const fmt = {
  hex: (v: number, w = 8): string =>
    "0x" + (v >>> 0).toString(16).toUpperCase().padStart(w, "0"),
  us: (t: number): string => {
    if (Math.abs(t) >= 1000) return (t / 1000).toFixed(3) + " ms";
    return Math.round(t) + " µs";
  },
  ns: (t: number): string => Math.round(t).toLocaleString() + " ns",
  time: (d: Date): string => {
    const p = (n: number, l = 2) => String(n).padStart(l, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  },
};

/// Parse the hex write field ("0x1F", "1f", "0X0a"); null when malformed.
export function parseHexInput(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const body = t.toLowerCase().startsWith("0x") ? t.slice(2) : t;
  if (body === "" || !/^[0-9a-fA-F]+$/.test(body)) return null;
  const v = parseInt(body, 16);
  return Number.isNaN(v) ? null : v >>> 0;
}
