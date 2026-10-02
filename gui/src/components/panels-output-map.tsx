// ============================================================
// panels-output-map.tsx — OutputControl + PinMapEditor
// Ported from design-reference panels-output-map.jsx (mechanical
// ESM/TSX conversion). The v2 map is per channel: the strip colours each
// channel by its direction bit, the boundary handle rewrites the direction
// mask as "ch0..n-1 outputs", the pull buttons set every input, and the
// notify checkbox sets the `edge` mask. "Load TOML…" opens a real file
// dialog and evaluates the file through the SDK config parser.
// ============================================================
import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { parseHexInput } from "../lib/fmt";
import { chBit, gpLabel, pinName } from "../lib/pins";
import { tauriAvailable } from "../lib/tauri";
import { NUM_PINS, PochiStore, useStore } from "../store/store";

// ---------------- OutputControl ----------------
export function OutputControl() {
  useStore(["pins", "map", "conn", "pattern"]);
  const S = PochiStore.get();
  const connected = S.connStatus === "connected";
  const locked = S.pattern.playState === "running";
  const outs = PochiStore.outputChannels();
  const [hex, setHex] = useState("");

  const disabled = !connected || outs.length === 0 || locked;

  function submitHex() {
    const v = parseHexInput(hex);
    if (v !== null) void PochiStore.writeHex(v);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {locked && (
        <div className="mono" style={{ fontSize: 10.5, color: "#fbbf24", background: "color-mix(in oklab,#fbbf24 12%, var(--surface-2))", border: "1px solid color-mix(in oklab,#fbbf24 30%, var(--border))", borderRadius: "var(--r-sm)", padding: "5px 8px" }}>
          ⏵ Pattern driving outputs — controls locked
        </div>
      )}
      {outs.length === 0 && (
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", padding: "10px 4px", lineHeight: 1.5 }}>No output pins configured. Set a split point in the Pin Map.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {outs.map((gp) => {
          const on = chBit(S.outputs, gp);
          return (
            <div key={gp} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 9px", borderRadius: "var(--r-sm)", background: on ? "color-mix(in oklab, var(--high) 8%, var(--surface-2))" : "var(--surface-2)", border: "1px solid " + (on ? "color-mix(in oklab,var(--high) 26%, var(--border-soft))" : "var(--border-soft)") }}>
              <span className="mono" title={pinName(gp)} style={{ fontSize: 12, fontWeight: 600, width: 40 }}>{gpLabel(gp)}</span>
              <span className={"dot-led " + (on ? "on" : "low")}></span>
              <span className="mono" style={{ fontSize: 10.5, color: on ? "var(--high)" : "var(--text-dim)", width: 34 }}>{on ? "HIGH" : "LOW"}</span>
              <div style={{ flex: 1 }} />
              <span className={"switch " + (on ? "on" : "")} onClick={() => !disabled && void PochiStore.toggleOutput(gp)} style={{ opacity: disabled ? 0.4 : 1, pointerEvents: disabled ? "none" : "auto" }}></span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} disabled={disabled} onClick={() => void PochiStore.setAllOutputs(true)}>All HIGH</button>
        <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} disabled={disabled} onClick={() => void PochiStore.setAllOutputs(false)}>All LOW</button>
        <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} disabled={disabled} onClick={() => void PochiStore.invertOutputs()}>Invert</button>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span className="eyebrow">write</span>
        <input className="field" placeholder="0x00" value={hex} disabled={disabled}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitHex(); }}
          style={{ flex: 1, minWidth: 0 }} />
        <button className="btn sm primary" disabled={disabled} onClick={submitHex}>Set</button>
      </div>
    </div>
  );
}

// ---------------- PinMapEditor ----------------
export function PinMapEditor() {
  useStore(["map", "conn"]);
  const S = PochiStore.get();
  const connected = S.connStatus === "connected";
  const stripRef = useRef<HTMLDivElement>(null);
  const N = NUM_PINS;
  const outCount = PochiStore.outputChannels().length;
  const pull = PochiStore.pullMode();
  // Open-drain has no protocol field in v2; the checkbox is local UI state.
  const [openDrain, setOpenDrain] = useState(false);

  function onBoundaryDrag(e: React.PointerEvent) {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      if (!stripRef.current) return;
      const rect = stripRef.current.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const idx = Math.round((x / rect.width) * N);
      PochiStore.setSplit(idx);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  async function loadToml() {
    if (!tauriAvailable) {
      PochiStore.addLog("error", "map load: file dialog requires the Tauri runtime");
      return;
    }
    const path = await open({ filters: [{ name: "TOML", extensions: ["toml"] }], multiple: false });
    if (typeof path === "string") await PochiStore.loadMapToml(path);
  }

  const cellW = `calc((100% - ${(N - 1) * 3}px) / ${N})`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, opacity: connected ? 1 : 0.5, pointerEvents: connected ? "auto" : "none" }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span className="eyebrow">ch0 — ch{N - 1} · GP0–GP22, GP26, GP27</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>{outCount} out / {N - outCount} in</span>
        </div>
        {/* strip */}
        <div ref={stripRef} style={{ position: "relative", display: "flex", gap: 3, padding: "2px 0" }}>
          {Array.from({ length: N }).map((_, gp) => {
            const isOut = PochiStore.gpDir(gp) === "output";
            return (
              <div key={gp} title={pinName(gp)} style={{ width: cellW, height: 34, borderRadius: 3, background: isOut ? "color-mix(in oklab, var(--accent) 30%, var(--surface-2))" : "color-mix(in oklab, #38bdf8 18%, var(--surface-2))", border: "1px solid " + (isOut ? "color-mix(in oklab, var(--accent) 50%, var(--border))" : "color-mix(in oklab,#38bdf8 35%, var(--border))"), display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span className="mono" style={{ fontSize: 8, color: "var(--text-secondary)" }}>{gp}</span>
              </div>
            );
          })}
          {/* boundary handle */}
          <div onPointerDown={onBoundaryDrag} style={{ position: "absolute", top: -3, bottom: -3, left: `calc(${(outCount / N) * 100}% - 6px)`, width: 12, cursor: "ew-resize", display: "flex", justifyContent: "center", zIndex: 2 }}>
            <div style={{ width: 3, background: "var(--warn)", borderRadius: 2, boxShadow: "0 0 8px color-mix(in oklab,var(--warn) 60%, transparent)" }}></div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          <span className="chip out">◀ OUTPUT {outCount}</span>
          <span className="chip in">INPUT {N - outCount} ▶</span>
        </div>
      </div>

      <Field label="Pull mode">
        <div className="seg" style={{ width: "100%" }}>
          {(["up", "down", "none"] as const).map((m) => (
            <button key={m} style={{ flex: 1 }} className={pull === m ? "active" : ""} onClick={() => PochiStore.setPull(m)}>{m}</button>
          ))}
        </div>
      </Field>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Check label="Change-notify on inputs" checked={PochiStore.edgeNotify()} onToggle={(on) => PochiStore.setEdgeNotify(on)} />
        <Check label="Open-drain outputs" checked={openDrain} onToggle={setOpenDrain} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <button className="btn primary sm" style={{ justifyContent: "center" }} onClick={() => void PochiStore.applyMap()}>Apply</button>
        <button className="btn sm" style={{ justifyContent: "center" }} onClick={() => void PochiStore.saveMap()}>Save to Flash</button>
        <button className="btn sm" style={{ justifyContent: "center" }} onClick={() => void PochiStore.defaultMap()}>Reset Default</button>
        <button className="btn sm" style={{ justifyContent: "center" }} onClick={() => void loadToml()}>Load TOML…</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  );
}
function Check({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: (on: boolean) => void }) {
  const on = checked;
  return (
    <label onClick={() => onToggle(!on)} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--text-secondary)", cursor: "pointer" }}>
      <span style={{ width: 15, height: 15, borderRadius: 3, border: "1px solid " + (on ? "var(--accent)" : "var(--border)"), background: on ? "var(--accent)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
        {on && <svg width="9" height="9" viewBox="0 0 12 12"><path d="M2 6l3 3 5-6" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </span>
      {label}
    </label>
  );
}
