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
import { formatHold, parseHoldInput } from "../lib/pattern";
import { pinLabel } from "../lib/pins";
import { PatternStepUi, TcapiStore, useStore } from "../store/store";

/// Hold field text → ticks. Text that is not a valid hold becomes 0, which
/// the field flags and the upload rejects with a clear error.
function parseHoldTicks(text: string, tickNs: number): number {
  try {
    return parseHoldInput(text, tickNs);
  } catch {
    return 0;
  }
}

// ---------------- PatternEditor ----------------
function PatternPreview({ steps, outs, curStep, playing }: { steps: PatternStepUi[]; outs: number[]; curStep: number; playing: boolean }) {
  const nOut = outs.length;
  const total = steps.reduce((a, s) => a + s.holdTicks, 0) || 1;
  const H = 11, GAP = 3, W = 100;
  const rows: React.JSX.Element[] = [];
  for (let row = 0; row < nOut; row++) {
    const ch = outs[row];
    let x = 0; const segs: React.JSX.Element[] = [];
    steps.forEach((s, si) => {
      const w = (s.holdTicks / total) * W;
      const on = (s.out >>> ch) & 1;
      segs.push(<rect key={si} x={x} y={on ? 0 : H * 0.55} width={Math.max(0.4, w - 0.3)} height={on ? H * 0.5 : H * 0.42} fill={on ? "var(--high)" : "#3a3a52"} rx="0.5" />);
      x += w;
    });
    rows.push(<g key={ch} transform={`translate(0 ${row * (H + GAP)})`}><line x1="0" y1={H} x2={W} y2={H} stroke="#23232f" strokeWidth="0.4" />{segs}</g>);
  }
  // current step marker
  let cx = 0; for (let i = 0; i < curStep; i++) cx += (steps[i]?.holdTicks || 0) / total * W;
  return (
    <svg viewBox={`0 0 ${W} ${nOut * (H + GAP)}`} style={{ width: "100%", height: nOut * (H + GAP) * 1.3, display: "block" }} preserveAspectRatio="none">
      {rows}
      {playing && <rect x={cx} y={0} width={(steps[curStep]?.holdTicks || 0) / total * W} height={nOut * (H + GAP)} fill="color-mix(in oklab, var(--accent) 22%, transparent)" />}
    </svg>
  );
}

export function PatternEditor() {
  useStore(["pattern", "map", "conn"]);
  const S = TcapiStore.get();
  const p = S.pattern;
  const connected = S.connStatus === "connected";
  const outs = TcapiStore.outputChannels();
  const nOut = outs.length;
  const running = p.playState === "running";
  const tickNs = TcapiStore.tickNs();

  async function loadFile() {
    if (!tauriAvailable) {
      TcapiStore.addLog("error", "pattern file: file dialog requires the Tauri runtime");
      return;
    }
    const path = await open({ filters: [{ name: "TOML", extensions: ["toml"] }], multiple: false });
    if (typeof path === "string") await TcapiStore.loadPatternToml(path);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11, opacity: connected ? 1 : 0.5, pointerEvents: connected ? "auto" : "none" }}>
      {/* preview */}
      <div style={{ background: "var(--scope-bg)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "8px 8px 6px" }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Timing Preview · {nOut}ch</div>
        <PatternPreview steps={p.steps} outs={outs} curStep={p.curStep} playing={running} />
      </div>

      {/* step table */}
      <div style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: "var(--surface-2)", borderBottom: "1px solid var(--border-soft)" }}>
          <span className="eyebrow" style={{ width: 22 }}>#</span>
          <span className="eyebrow" style={{ flex: 1 }}>output bits (MSB→LSB)</span>
          <span className="eyebrow" style={{ width: 108, textAlign: "right" }}>hold (ticks · {tickNs} ns)</span>
        </div>
        <div className="scroll-y" style={{ maxHeight: 188 }}>
          {p.steps.map((s, i) => (
            <StepRow key={i} step={s} idx={i} outs={outs} tickNs={tickNs} active={running && p.curStep === i} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, padding: 7, borderTop: "1px solid var(--border-soft)" }}>
          <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => TcapiStore.addStep()}>+ Step</button>
          <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => void TcapiStore.loadPattern(p.steps)}>↑ Upload</button>
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
          <button className={p.mode === "once" ? "active" : ""} onClick={() => TcapiStore.setPatternMode("once")}>Once</button>
          <button className={p.mode === "loop" ? "active" : ""} onClick={() => TcapiStore.setPatternMode("loop")}>Loop</button>
        </div>
        {p.mode === "loop" && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span className="eyebrow">×</span>
            <input className="field" style={{ width: 50 }} value={p.repeat || ""} placeholder="∞" onChange={(e) => TcapiStore.setPatternRepeat(parseInt(e.target.value) || 0)} />
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {!running ? (
          <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} disabled={!p.steps.length} onClick={() => void TcapiStore.runPattern()}>▶ Run</button>
        ) : (
          <button className="btn danger" style={{ flex: 1, justifyContent: "center" }} onClick={() => void TcapiStore.stopPattern()}>■ Stop</button>
        )}
        <button className="btn" onClick={() => void loadFile()}>Load File…</button>
      </div>
    </div>
  );
}

/// Hold field that keeps its own text so partial input such as "1." survives
/// while typing; the parsed tick count is pushed to the store on every
/// change and shown with its nanosecond equivalent underneath. Plain numbers
/// are ticks; `ns` / `us` / `ms` suffixes are converted.
function HoldInput({ holdTicks, tickNs, onChange }: { holdTicks: number; tickNs: number; onChange: (holdTicks: number) => void }) {
  const [text, setText] = useState(String(holdTicks));
  const [lastTicks, setLastTicks] = useState(holdTicks);
  if (holdTicks !== lastTicks) {
    // Changed from outside (TOML load, step removal): follow the store.
    setLastTicks(holdTicks);
    setText(String(holdTicks));
  }
  const valid = holdTicks >= 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", width: 108 }}>
      <input className="field" value={text} aria-label="hold ticks" aria-invalid={!valid}
        onChange={(e) => {
          const ticks = parseHoldTicks(e.target.value, tickNs);
          setText(e.target.value);
          setLastTicks(ticks);
          onChange(ticks);
        }}
        style={{ width: 96, padding: "3px 6px", fontSize: 11, textAlign: "right", borderColor: valid ? undefined : "#ef4444" }} />
      <span className="mono dim" data-testid="hold-readout" style={{ fontSize: 8.5, color: valid ? undefined : "#ef4444" }}>
        {valid ? formatHold(holdTicks, tickNs) : "invalid hold"}
      </span>
    </div>
  );
}

function StepRow({ step, idx, outs, tickNs, active }: { step: PatternStepUi; idx: number; outs: number[]; tickNs: number; active: boolean }) {
  const bits = [];
  for (let i = outs.length - 1; i >= 0; i--) {
    const b = outs[i];
    const on = (step.out >>> b) & 1;
    bits.push(
      <button key={b} title={pinLabel(b)} onClick={() => TcapiStore.updateStep(idx, { out: (step.out ^ (1 << b)) >>> 0 })}
        style={{ width: 15, height: 17, borderRadius: 2, border: "1px solid " + (on ? "var(--high)" : "var(--border)"), background: on ? "var(--high)" : "var(--scope-bg)", cursor: "pointer", padding: 0, color: on ? "#0d0d15" : "var(--text-dim)", fontSize: 8, fontWeight: 700, fontFamily: "var(--font-mono)" }}>
        {on ? "1" : "0"}
      </button>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderBottom: "1px solid var(--border-soft)", background: active ? "color-mix(in oklab, var(--accent) 14%, transparent)" : "transparent" }}>
      <span className="mono" style={{ width: 22, fontSize: 10.5, color: "var(--text-dim)" }}>{String(idx).padStart(2, "0")}</span>
      <div style={{ flex: 1, display: "flex", gap: 2, flexWrap: "wrap" }}>{bits}</div>
      <HoldInput holdTicks={step.holdTicks} tickNs={tickNs} onChange={(holdTicks) => TcapiStore.updateStep(idx, { holdTicks })} />
      <button className="btn ghost icon sm" style={{ width: 20, height: 20 }} onClick={() => TcapiStore.removeStep(idx)} title="remove">×</button>
    </div>
  );
}

// ---------------- TimestampViewer ----------------
export function TimestampViewer() {
  useStore(["ts", "conn"]);
  const S = TcapiStore.get();
  const connected = S.connStatus === "connected";
  const ts = S.ts;
  const [reconcile, setReconcile] = useState(true);
  const res = ts.result;
  const tsDepth = S.capabilities?.tsDepth ?? 4096;

  // ts arm takes a physical GP bit mask that must be a subset of the input
  // pins (R-PIN2); "all inputs" is exactly the complement of the direction
  // mask within the DIO pins.
  function allInputsMask() {
    return TcapiStore.inputMask();
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
            <button key={e} className={ts.edge === e ? "active" : ""} onClick={() => void TcapiStore.armTs(ts.armed ? ts.mask : allInputsMask(), e)}>{e}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        {!ts.armed ? (
          <button className="btn primary sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => void TcapiStore.armTs(allInputsMask(), ts.edge)}>Arm</button>
        ) : (
          <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => void TcapiStore.disarmTs()}>Disarm</button>
        )}
        <button className="btn sm" style={{ flex: 1, justifyContent: "center" }} disabled={!ts.armed} onClick={() => void TcapiStore.captureTs(reconcile)}>Capture</button>
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

type TsResultUi = NonNullable<ReturnType<typeof TcapiStore.get>["ts"]["result"]>;

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
      TcapiStore.addLog("received", `export ${kind}: ${res.rows.length} rows → ${path}`);
    } catch (e) {
      TcapiStore.addLog("error", `export ${kind}: ${e instanceof Error ? e.message : String(e)}`);
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
