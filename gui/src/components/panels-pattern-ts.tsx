// ============================================================
// panels-pattern-ts.tsx — PatternEditor + TimestampViewer
// Ported from design-reference panels-pattern-ts.jsx (mechanical
// ESM/TSX conversion). "Load File…" and the exports use real
// file dialogs; capture goes through ts_get / ts_get_reconciled.
// ============================================================
import { useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { fmt } from "../lib/fmt";
import { invoke, tauriAvailable } from "../lib/tauri";
import { NUM_PINS, PatternStepUi, PochiStore, useStore } from "../store/store";

// ---------------- PatternEditor ----------------
function PatternPreview({ steps, nOut, curStep, playing }: { steps: PatternStepUi[]; nOut: number; curStep: number; playing: boolean }) {
  const total = steps.reduce((a, s) => a + s.hold, 0) || 1;
  const H = 11, GAP = 3, W = 100;
  const rows: React.JSX.Element[] = [];
  for (let ch = 0; ch < nOut; ch++) {
    let x = 0; const segs: React.JSX.Element[] = [];
    steps.forEach((s, si) => {
      const w = (s.hold / total) * W;
      const on = (s.out >> ch) & 1;
      segs.push(<rect key={si} x={x} y={on ? 0 : H * 0.55} width={Math.max(0.4, w - 0.3)} height={on ? H * 0.5 : H * 0.42} fill={on ? "var(--high)" : "#3a3a52"} rx="0.5" />);
      x += w;
    });
    rows.push(<g key={ch} transform={`translate(0 ${ch * (H + GAP)})`}><line x1="0" y1={H} x2={W} y2={H} stroke="#23232f" strokeWidth="0.4" />{segs}</g>);
  }
  // current step marker
  let cx = 0; for (let i = 0; i < curStep; i++) cx += (steps[i]?.hold || 0) / total * W;
  return (
    <svg viewBox={`0 0 ${W} ${nOut * (H + GAP)}`} style={{ width: "100%", height: nOut * (H + GAP) * 1.3, display: "block" }} preserveAspectRatio="none">
      {rows}
      {playing && <rect x={cx} y={0} width={(steps[curStep]?.hold || 0) / total * W} height={nOut * (H + GAP)} fill="color-mix(in oklab, var(--accent) 22%, transparent)" />}
    </svg>
  );
}

export function PatternEditor() {
  useStore(["pattern", "map", "conn"]);
  const S = PochiStore.get();
  const p = S.pattern;
  const connected = S.connStatus === "connected";
  const nOut = S.splitIndex;
  const running = p.playState === "running";

  async function loadFile() {
    if (!tauriAvailable) {
      PochiStore.addLog("error", "pattern load: file dialog requires the Tauri runtime");
      return;
    }
    const path = await open({ filters: [{ name: "TOML", extensions: ["toml"] }], multiple: false });
    if (typeof path === "string") await PochiStore.loadPatternToml(path);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11, opacity: connected ? 1 : 0.5, pointerEvents: connected ? "auto" : "none" }}>
      {/* preview */}
      <div style={{ background: "var(--scope-bg)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "8px 8px 6px" }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Timing Preview · {nOut}ch</div>
        <PatternPreview steps={p.steps} nOut={nOut} curStep={p.curStep} playing={running} />
      </div>

      {/* step table */}
      <div style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: "var(--surface-2)", borderBottom: "1px solid var(--border-soft)" }}>
          <span className="eyebrow" style={{ width: 22 }}>#</span>
          <span className="eyebrow" style={{ flex: 1 }}>output bits (MSB→LSB)</span>
          <span className="eyebrow" style={{ width: 56, textAlign: "right" }}>hold µs</span>
        </div>
        <div className="scroll-y" style={{ maxHeight: 188 }}>
          {p.steps.map((s, i) => (
            <StepRow key={i} step={s} idx={i} nOut={nOut} active={running && p.curStep === i} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, padding: 7, borderTop: "1px solid var(--border-soft)" }}>
          <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => PochiStore.addStep()}>+ Step</button>
          <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => void PochiStore.loadPattern(p.steps)}>↑ Upload</button>
        </div>
      </div>

      {/* status + accepted */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
        <span className={"dot-led " + (running ? "busy" : p.playState === "done" ? "on" : "low")}></span>
        <span className="mono" style={{ color: "var(--text-secondary)" }}>
          {running ? `RUN step ${p.curStep + 1}/${p.steps.length}` : p.playState === "done" ? "DONE" : "IDLE"}
        </span>
        {p.mode === "loop" && <span className="mono dim" style={{ fontSize: 10 }}>loops {p.loops}{p.repeat ? "/" + p.repeat : ""}</span>}
        {p.accepted != null && <span className="chip mono" style={{ marginLeft: "auto" }}>{p.accepted} accepted</span>}
      </div>

      {/* mode + controls */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div className="seg">
          <button className={p.mode === "once" ? "active" : ""} onClick={() => PochiStore.setPatternMode("once")}>Once</button>
          <button className={p.mode === "loop" ? "active" : ""} onClick={() => PochiStore.setPatternMode("loop")}>Loop</button>
        </div>
        {p.mode === "loop" && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span className="eyebrow">×</span>
            <input className="field" style={{ width: 50 }} value={p.repeat || ""} placeholder="∞" onChange={(e) => PochiStore.setPatternRepeat(parseInt(e.target.value) || 0)} />
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {!running ? (
          <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} disabled={!p.steps.length} onClick={() => void PochiStore.runPattern()}>▶ Run</button>
        ) : (
          <button className="btn danger" style={{ flex: 1, justifyContent: "center" }} onClick={() => void PochiStore.stopPattern()}>■ Stop</button>
        )}
        <button className="btn" onClick={() => void loadFile()}>Load File…</button>
      </div>
    </div>
  );
}

function StepRow({ step, idx, nOut, active }: { step: PatternStepUi; idx: number; nOut: number; active: boolean }) {
  const bits = [];
  for (let b = nOut - 1; b >= 0; b--) {
    const on = (step.out >> b) & 1;
    bits.push(
      <button key={b} onClick={() => PochiStore.updateStep(idx, { out: (step.out ^ (1 << b)) >>> 0 })}
        style={{ width: 15, height: 17, borderRadius: 2, border: "1px solid " + (on ? "var(--high)" : "var(--border)"), background: on ? "var(--high)" : "var(--scope-bg)", cursor: "pointer", padding: 0, color: on ? "#0d0d15" : "var(--text-dim)", fontSize: 8, fontWeight: 700, fontFamily: "var(--font-mono)" }}>
        {on ? "1" : "0"}
      </button>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderBottom: "1px solid var(--border-soft)", background: active ? "color-mix(in oklab, var(--accent) 14%, transparent)" : "transparent" }}>
      <span className="mono" style={{ width: 22, fontSize: 10.5, color: "var(--text-dim)" }}>{String(idx).padStart(2, "0")}</span>
      <div style={{ flex: 1, display: "flex", gap: 2, flexWrap: "wrap" }}>{bits}</div>
      <input className="field" value={step.hold} onChange={(e) => PochiStore.updateStep(idx, { hold: parseInt(e.target.value) || 0 })} style={{ width: 52, padding: "3px 6px", fontSize: 11, textAlign: "right" }} />
      <button className="btn ghost icon sm" style={{ width: 20, height: 20 }} onClick={() => PochiStore.removeStep(idx)} title="remove">×</button>
    </div>
  );
}

// ---------------- TimestampViewer ----------------
export function TimestampViewer() {
  useStore(["ts", "conn"]);
  const S = PochiStore.get();
  const connected = S.connStatus === "connected";
  const ts = S.ts;
  const [reconcile, setReconcile] = useState(true);
  const res = ts.result;
  const tsDepth = S.capabilities?.tsDepth ?? 4096;

  // ts arm takes an *input-channel* bitmask (bit c = channel c), not GPs.
  // The FW rejects mask bits beyond caps.in_count even when the pin map
  // assigns more inputs, so clamp to whichever is smaller.
  function allInputsMask() {
    const n = Math.min(NUM_PINS - S.splitIndex, S.capabilities?.inCount ?? NUM_PINS);
    let m = 0;
    for (let c = 0; c < n; c++) m |= 1 << c;
    return m >>> 0;
  }

  const stats = useMemo(() => {
    if (!res || !res.rows.length) return null;
    const ns = res.rows.map((r) => r.computedNs);
    const ivals = [];
    for (let i = 1; i < ns.length; i++) ivals.push(ns[i] - ns[i - 1]);
    return {
      count: res.rows.length,
      span: res.span,
      min: ivals.length ? Math.min(...ivals) : 0,
      max: ivals.length ? Math.max(...ivals) : 0,
      recon: res.rows.filter((r) => r.reconciled).length,
    };
  }, [res]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, opacity: connected ? 1 : 0.5, pointerEvents: connected ? "auto" : "none", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className={"dot-led " + (ts.armed ? "busy" : "low")}></span>
        <span className="mono" style={{ fontSize: 11, color: ts.armed ? "#fbbf24" : "var(--text-secondary)" }}>{ts.armed ? "ARMED" : "DISARMED"}</span>
        <div style={{ flex: 1 }} />
        <span className="mono dim" style={{ fontSize: 10 }}>buffer {ts.bufferEst}/{tsDepth}</span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="eyebrow">edge</span>
        <div className="seg">
          {(["rising", "falling", "both"] as const).map((e) => (
            <button key={e} className={ts.edge === e ? "active" : ""} onClick={() => void PochiStore.armTs(ts.armed ? ts.mask : allInputsMask(), e)}>{e}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        {!ts.armed ? (
          <button className="btn primary sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => void PochiStore.armTs(allInputsMask(), ts.edge)}>Arm</button>
        ) : (
          <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => void PochiStore.disarmTs()}>Disarm</button>
        )}
        <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} disabled={!ts.armed} onClick={() => void PochiStore.captureTs(reconcile)}>Capture</button>
      </div>
      <label onClick={() => setReconcile(!reconcile)} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
        <span className={"switch " + (reconcile ? "on" : "")} style={{ transform: "scale(.8)" }}></span>
        Reconcile timestamps
      </label>

      {/* device buffer overflowed during capture: events were dropped */}
      {res?.overflow && (
        <div className="mono" style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", fontSize: 10, color: "#ef4444", background: "color-mix(in oklab, #ef4444 12%, transparent)", borderRadius: "var(--r-sm)", border: "1px solid color-mix(in oklab, #ef4444 35%, transparent)" }}>
          <span className="dot-led err"></span>
          OVERFLOW — capture buffer full, events dropped
        </div>
      )}

      {/* summary */}
      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "8px", background: "var(--surface-2)", borderRadius: "var(--r-sm)", border: "1px solid var(--border-soft)" }}>
          <Stat k="events" v={stats.count} />
          <Stat k="span" v={(stats.span / 1000).toFixed(1) + " µs"} />
          <Stat k="min Δ" v={(stats.min / 1000).toFixed(2) + " µs"} />
          <Stat k="max Δ" v={(stats.max / 1000).toFixed(2) + " µs"} />
        </div>
      )}

      {/* table */}
      <div style={{ flex: 1, minHeight: 90, border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 64px 70px", gap: 4, padding: "5px 8px", background: "var(--surface-2)", borderBottom: "1px solid var(--border-soft)" }}>
          {["#", "inputs", "raw", "ns"].map((h) => <span key={h} className="eyebrow" style={{ fontSize: 8.5 }}>{h}</span>)}
        </div>
        <div className="scroll-y" style={{ flex: 1 }}>
          {!res && <div style={{ padding: 16, textAlign: "center", color: "var(--text-dim)", fontSize: 11 }}>{ts.armed ? "Capturing edges… click Capture" : "Arm to capture timestamps"}</div>}
          {res && res.rows.slice(-200).reverse().map((r) => (
            <div key={r.idx} style={{ display: "grid", gridTemplateColumns: "28px 1fr 64px 70px", gap: 4, padding: "3px 8px", borderBottom: "1px solid var(--border-soft)", background: r.reconciled ? "color-mix(in oklab, #fbbf24 12%, transparent)" : "transparent" }}>
              <span className="mono" style={{ fontSize: 9.5, color: "var(--text-dim)" }}>{r.idx}</span>
              <span className="mono" style={{ fontSize: 9.5, color: "#7dd3fc" }}>{fmt.hex(r.inputs)}</span>
              <span className="mono" style={{ fontSize: 9.5, color: "var(--text-secondary)" }}>{r.rawCount}<span style={{ color: "var(--text-dim)" }}>.{r.rawPhase}</span></span>
              <span className="mono" style={{ fontSize: 9.5, color: r.reconciled ? "#fbbf24" : "var(--text)" }}>{Math.round(r.computedNs).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} disabled={!res} onClick={() => void exportData("csv", res)}>Export CSV</button>
        <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} disabled={!res} onClick={() => void exportData("json", res)}>Export JSON</button>
      </div>
    </div>
  );
}

type TsResultUi = NonNullable<ReturnType<typeof PochiStore.get>["ts"]["result"]>;

async function exportData(kind: "csv" | "json", res: TsResultUi | null) {
  if (!res) return;
  const contents =
    kind === "csv"
      ? ["idx,inputs,raw_count,raw_phase,sync_active,timestamp_ns,reconciled"]
          .concat(
            res.rows.map((r) =>
              [r.idx, fmt.hex(r.inputs), r.rawCount, r.rawPhase, r.syncActive ? 1 : 0, Math.round(r.computedNs), r.reconciled ? 1 : 0].join(","),
            ),
          )
          .join("\n") + "\n"
      : JSON.stringify(
          {
            reconciled: res.reconciled,
            overflow: res.overflow,
            events: res.rows.map((r) => ({
              inputs: r.inputs,
              raw_count: r.rawCount,
              raw_phase: r.rawPhase,
              sync_active: r.syncActive,
              timestamp_ns: Math.round(r.computedNs),
              reconciled: r.reconciled,
            })),
          },
          null,
          2,
        ) + "\n";

  if (!tauriAvailable) {
    // Browser preview: download via a blob anchor.
    const blob = new Blob([contents], { type: kind === "csv" ? "text/csv" : "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `timestamps.${kind}`;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  const path = await save({
    defaultPath: `timestamps.${kind}`,
    filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
  });
  if (path) {
    try {
      await invoke("write_text_file", { path, contents });
      PochiStore.addLog("received", `export ${kind}: ${res.rows.length} rows → ${path}`);
    } catch (e) {
      PochiStore.addLog("error", `export ${kind}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function Stat({ k, v }: { k: string; v: string | number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span className="eyebrow" style={{ fontSize: 8.5 }}>{k}</span>
      <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{v}</span>
    </div>
  );
}
