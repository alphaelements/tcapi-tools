// ============================================================
// panels-output-map.tsx — OutputControl + PinMapEditor
// Ported from design-reference panels-output-map.jsx (mechanical
// ESM/TSX conversion). The v2 map is per channel: the editor is a 25-row
// table (ch0-ch24, labelled `GPn (chm)`) with the direction, pull, def,
// opol, ipol and edge key of every channel; `flags` is shown read-only.
// "Load TOML…" opens a real file dialog and evaluates the file through the
// SDK config parser.
// ============================================================
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { parseHexInput } from "../lib/fmt";
import type { ChannelFlag, PullMode } from "../lib/pinmap";
import { chBit, pinLabel } from "../lib/pins";
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
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", padding: "10px 4px", lineHeight: 1.5 }}>No output pins configured. Make a channel an output in the Pin Map.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {outs.map((ch) => {
          const on = chBit(S.outputs, ch);
          return (
            <div key={ch} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 9px", borderRadius: "var(--r-sm)", background: on ? "color-mix(in oklab, var(--high) 8%, var(--surface-2))" : "var(--surface-2)", border: "1px solid " + (on ? "color-mix(in oklab,var(--high) 26%, var(--border-soft))" : "var(--border-soft)") }}>
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, width: 78 }}>{pinLabel(ch)}</span>
              <span className={"dot-led " + (on ? "on" : "low")}></span>
              <span className="mono" style={{ fontSize: 10.5, color: on ? "var(--high)" : "var(--text-dim)", width: 34 }}>{on ? "HIGH" : "LOW"}</span>
              <div style={{ flex: 1 }} />
              <span className={"switch " + (on ? "on" : "")} onClick={() => !disabled && void PochiStore.toggleOutput(ch)} style={{ opacity: disabled ? 0.4 : 1, pointerEvents: disabled ? "none" : "auto" }}></span>
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
const PULL_MODES: readonly PullMode[] = ["up", "down", "none"];
const GRID = "78px 34px 54px repeat(4, 1fr)";
/// Narrowest table that still shows all seven columns; a narrower dock scrolls it sideways.
const TABLE_MIN_W = 300;

/// One checkbox cell of the table; `—` when the key does not apply to the
/// channel's role (R-M1).
function FlagCell({ ch, flag, label, applies, on }: { ch: number; flag: ChannelFlag; label: string; applies: boolean; on: boolean }) {
  if (!applies) return <span className="mono dim" style={{ textAlign: "center", fontSize: 10 }}>—</span>;
  return (
    <input type="checkbox" checked={on} aria-label={`${pinLabel(ch)} ${label}`} data-testid={`map-${flag}-${ch}`}
      onChange={(e) => PochiStore.setChannelFlag(ch, flag, e.target.checked)}
      style={{ margin: "0 auto", accentColor: "var(--accent)" }} />
  );
}

function MapRow({ ch }: { ch: number }) {
  const c = PochiStore.channelConfig(ch);
  const isOut = c.role === "output";
  return (
    <div data-testid={`map-row-${ch}`} style={{ display: "grid", gridTemplateColumns: GRID, gap: 4, alignItems: "center", padding: "3px 8px", borderBottom: "1px solid var(--border-soft)" }}>
      <span className="mono" style={{ fontSize: 10.5, fontWeight: 600 }}>{pinLabel(ch)}</span>
      <button className={"chip " + (isOut ? "out" : "in")} data-testid={`map-role-${ch}`} title={`${pinLabel(ch)}: click to make it an ${isOut ? "input" : "output"}`}
        onClick={() => PochiStore.setChannelRole(ch, isOut ? "input" : "output")}
        style={{ fontSize: 8.5, padding: "1px 4px", cursor: "pointer", justifyContent: "center" }}>
        {isOut ? "OUT" : "IN"}
      </button>
      {isOut ? (
        <span className="mono dim" style={{ textAlign: "center", fontSize: 10 }}>—</span>
      ) : (
        <select className="field" aria-label={`${pinLabel(ch)} pull`} data-testid={`map-pull-${ch}`} value={c.pull}
          onChange={(e) => PochiStore.setChannelPull(ch, e.target.value as PullMode)}
          style={{ padding: "1px 2px", fontSize: 10 }}>
          {PULL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      )}
      <FlagCell ch={ch} flag="out_default" label="def" applies={isOut} on={c.outDefault} />
      <FlagCell ch={ch} flag="out_polarity" label="opol" applies={isOut} on={c.outPolarity} />
      <FlagCell ch={ch} flag="in_polarity" label="ipol" applies={!isOut} on={c.inPolarity} />
      <FlagCell ch={ch} flag="edge" label="edge" applies={!isOut} on={c.edge} />
    </div>
  );
}

export function PinMapEditor() {
  useStore(["map", "conn"]);
  const S = PochiStore.get();
  const connected = S.connStatus === "connected";
  const outCount = PochiStore.outputChannels().length;
  const channels = Array.from({ length: NUM_PINS }, (_, ch) => ch);

  async function loadToml() {
    if (!tauriAvailable) {
      PochiStore.addLog("error", "map load: file dialog requires the Tauri runtime");
      return;
    }
    const path = await open({ filters: [{ name: "TOML", extensions: ["toml"] }], multiple: false });
    if (typeof path === "string") await PochiStore.loadMapToml(path);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, opacity: connected ? 1 : 0.5, pointerEvents: connected ? "auto" : "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span className="eyebrow">ch0 — ch{NUM_PINS - 1} · GP0–GP22, GP26, GP27</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>{outCount} out / {NUM_PINS - outCount} in</span>
      </div>

      <div style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", overflowX: "auto", overflowY: "hidden" }}>
       <div style={{ minWidth: TABLE_MIN_W }}>
        <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 4, padding: "5px 8px", background: "var(--surface-2)", borderBottom: "1px solid var(--border-soft)" }}>
          {["pin", "dir", "pull", "def", "opol", "ipol", "edge"].map((h) => <span key={h} className="eyebrow" style={{ fontSize: 8.5 }}>{h}</span>)}
        </div>
        <div className="scroll-y" data-testid="map-rows" style={{ maxHeight: 330 }}>
          {channels.map((ch) => <MapRow key={ch} ch={ch} />)}
        </div>
       </div>
      </div>

      <span className="mono dim" data-testid="map-flags" style={{ fontSize: 10 }}>flags 0x{S.map.flags.toString(16).padStart(2, "0")} (reserved)</span>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <button className="btn primary sm" style={{ justifyContent: "center" }} onClick={() => void PochiStore.applyMap()}>Apply</button>
        <button className="btn sm" style={{ justifyContent: "center" }} onClick={() => void PochiStore.saveMap()}>Save to Flash</button>
        <button className="btn sm" style={{ justifyContent: "center" }} onClick={() => void PochiStore.defaultMap()}>Reset Default</button>
        <button className="btn sm" style={{ justifyContent: "center" }} onClick={() => void loadToml()}>Load TOML…</button>
      </div>
    </div>
  );
}
