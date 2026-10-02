// ============================================================
// panels-gpio.tsx — GpioMonitor (center top, 25 channels live)
// Ported from design-reference panels-gpio.jsx (mechanical
// ESM/TSX conversion; data source is the live store instead of
// the simulation snapshot helpers).
// ============================================================
import { chToGp, pinLabel } from "../lib/pins";
import { fmt, NUM_PINS, PochiStore, useStore } from "../store/store";
import type { Tweaks } from "./settings";

function PinIndicator({ shape, state, color }: { shape: string; state: "high" | "low" | "unassigned"; color: string }) {
  const on = state === "high";
  const base = { transition: "background .12s, box-shadow .12s, border-color .12s", flex: "none" } as const;
  const glow = on ? "0 0 9px " + color + "aa, 0 0 0 1px rgba(0,0,0,.3) inset" : "0 0 0 1px rgba(0,0,0,.35) inset";
  if (shape === "led") {
    return (
      <div style={{ ...base, width: 30, height: 8, borderRadius: 3, background: on ? color : "#23232f", boxShadow: glow, border: "1px solid " + (on ? color : "var(--border)") }}></div>
    );
  }
  const sq = shape === "square";
  return (
    <div style={{
      ...base, width: 18, height: 18,
      borderRadius: sq ? 4 : "50%",
      background: on ? color : "transparent",
      border: "2px solid " + (state === "unassigned" ? "var(--border)" : on ? color : "var(--low)"),
      boxShadow: on ? "0 0 9px " + color + "aa" : "none",
    }}></div>
  );
}

function PinCell({ ch, layout, shape }: { ch: number; layout: string; shape: string }) {
  const S = PochiStore.get();
  const dir = PochiStore.gpDir(ch);
  const val = S.pinMeta[ch].value;
  const isInput = dir === "input";
  const stateColor = val ? "#22c55e" : "#64748b";
  const last = S.pinMeta[ch].lastChangeMs;
  const tip = `${pinLabel(ch)} · ${dir.toUpperCase()} · ${val ? "HIGH" : "LOW"}\npull: ${S.pinMeta[ch].pull}\nlast Δ: ${last != null ? (last / 1000).toFixed(2) + " ms" : "—"} · edges: ${S.pinMeta[ch].edges}`;

  const row = layout === "row";
  return (
    <div title={tip} style={{
      display: "flex", flexDirection: row ? "row" : "column", alignItems: "center",
      gap: row ? 9 : 6,
      justifyContent: row ? "flex-start" : "center",
      padding: row ? "6px 9px" : "9px 4px",
      borderRadius: "var(--r-md)",
      background: val ? "color-mix(in oklab, var(--high) 9%, var(--surface-2))" : "var(--surface-2)",
      border: "1px solid " + (val ? "color-mix(in oklab, var(--high) 28%, var(--border-soft))" : "var(--border-soft)"),
      minWidth: row ? 0 : 50, cursor: "default",
      transition: "background .12s, border-color .12s",
    }}>
      <span className="mono" style={{ display: "flex", flexDirection: row ? "row" : "column", alignItems: "center", gap: row ? 4 : 0, lineHeight: 1.15, fontWeight: 600, color: "var(--text)", order: row ? 0 : -1 }}>
        <span style={{ fontSize: 11 }}>GP{chToGp(ch)}</span>
        <span style={{ fontSize: 8.5, color: "var(--text-dim)", fontWeight: 400 }}>(ch{ch})</span>
      </span>
      <PinIndicator shape={shape} state={val ? "high" : "low"} color={stateColor} />
      <span className={"chip " + (isInput ? "in" : "out")} style={{ fontSize: 8.5, padding: "1px 5px" }}>{isInput ? "IN" : "OUT"}</span>
    </div>
  );
}

export function GpioMonitor({ tweaks }: { tweaks: Tweaks }) {
  useStore(["pins", "map", "conn"]);
  const S = PochiStore.get();
  const connected = S.connStatus === "connected";
  const pins: number[] = [];
  for (let ch = 0; ch < NUM_PINS; ch++) pins.push(ch);

  const layout = tweaks.pinLayout || "grid"; // row | rows2 | grid
  const shape = tweaks.pinShape || "circle";

  let gridStyle: React.CSSProperties;
  if (layout === "row") gridStyle = { display: "flex", flexWrap: "nowrap", gap: 6, overflowX: "auto", paddingBottom: 4 };
  else if (layout === "rows2") gridStyle = { display: "grid", gridTemplateColumns: "repeat(12, minmax(0,1fr))", gap: 6 };
  else gridStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(58px, 1fr))", gap: 6 };

  const inHex = fmt.hex(connected ? S.inputs : 0);
  const outHex = fmt.hex(connected ? S.outputs : 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderBottom: "1px solid var(--border-soft)" }}>
        <span className="panel-title">GPIO Monitor</span>
        <div style={{ flex: 1 }} />
        <Readout label="IN" value={inHex} color="#7dd3fc" />
        <Readout label="OUT" value={outHex} color="#c4b5fd" />
        <div style={{ flex: 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
          <span className={"switch " + (S.subscribed ? "on" : "")} onClick={() => connected && void PochiStore.setSubscribe(!S.subscribed)} style={{ transform: "scale(.82)" }}></span>
          Live
        </label>
        <button className="btn sm" onClick={() => void PochiStore.readState()} disabled={!connected}>Read</button>
      </div>
      <div className="scroll-y" style={{ flex: 1, padding: 12, opacity: connected ? 1 : 0.45, pointerEvents: connected ? "auto" : "none" }}>
        <div style={gridStyle}>
          {pins.map((ch) => <PinCell key={ch} ch={ch} layout={layout} shape={shape} />)}
        </div>
      </div>
    </div>
  );
}

function Readout({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, background: "var(--scope-bg)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "3px 9px" }}>
      <span className="eyebrow" style={{ fontSize: 9, color }}>{label}</span>
      <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", letterSpacing: ".02em" }}>{value}</span>
    </div>
  );
}
