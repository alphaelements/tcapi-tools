// ============================================================
// waveform.tsx — oscilloscope-style logic analyzer canvas
// Ported from design-reference waveform.jsx. The Canvas drawing
// logic (graticule, lanes, cursors, glow) is unchanged; the data
// source is the store's edge-history ring buffers instead of the
// simulation's pure signal functions.
// ============================================================
import { useEffect, useRef } from "react";
import { pinLabel } from "../lib/pins";
import { TcapiStore, useStore } from "../store/store";
import type { Tweaks } from "./settings";

const CHAN_COLORS = [
  "#22c55e", "#38bdf8", "#a78bfa", "#f472b6", "#fbbf24",
  "#34d399", "#60a5fa", "#f87171", "#c084fc", "#2dd4bf",
  "#facc15", "#fb923c", "#4ade80", "#818cf8", "#e879f9",
];

function channelLabel(ch: number): string {
  return TcapiStore.gpDir(ch) === "input" ? "IN" : "OUT";
}

export function WaveformViewer({ tweaks }: { tweaks: Tweaks }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tweakRef = useRef(tweaks);
  tweakRef.current = tweaks;
  const dragRef = useRef<{ idx: number; tStart: number; winUs: number; plotW: number; PAD_L: number } | null>(null);
  useStore(["map", "conn", "ui"]); // re-render on monitored/connection/rec/window changes (the per-frame "sim" tick is read by the canvas loop)

  // cursor read-out (updates via rAF through ref to avoid React churn)
  const readoutRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf: number;
    const PAD_L = 92, PAD_R = 14, PAD_T = 10, PAD_B = 22;

    function laneList() {
      const S = TcapiStore.get();
      return [...S.monitored].sort((a, b) => a - b);
    }

    function draw() {
      if (!canvas || !ctx) return;
      const S = TcapiStore.get();
      const tw = tweakRef.current;
      const style = tw.waveformStyle || "scope";
      const wrap = wrapRef.current;
      if (!wrap) return;
      const W = wrap.clientWidth, H = wrap.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr; canvas.height = H * dpr;
        canvas.style.width = W + "px"; canvas.style.height = H + "px";
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // background
      ctx.fillStyle = style === "minimal" ? "#181824" : "#14141f";
      ctx.fillRect(0, 0, W, H);

      const lanes = laneList();
      const plotW = W - PAD_L - PAD_R;
      const plotH = H - PAD_T - PAD_B;
      const winUs = S.windowUs;
      const connected = S.connStatus === "connected";
      const tEnd = connected ? S.streamT : winUs;
      const tStart = tEnd - winUs;

      const xOf = (t: number) => PAD_L + ((t - tStart) / winUs) * plotW;

      // ---- graticule ----
      const divs = 10;
      ctx.lineWidth = 1;
      for (let i = 0; i <= divs; i++) {
        const x = PAD_L + (i / divs) * plotW;
        ctx.strokeStyle = i % 5 === 0 ? "#313147" : "#23232f";
        ctx.beginPath(); ctx.moveTo(x + 0.5, PAD_T); ctx.lineTo(x + 0.5, PAD_T + plotH); ctx.stroke();
      }

      if (!connected || lanes.length === 0) {
        ctx.fillStyle = "#5b6577";
        ctx.font = '12px "IBM Plex Mono", monospace';
        ctx.textAlign = "center";
        ctx.fillText(connected ? "NO CHANNELS — enable inputs in the channel list" : "NO SIGNAL — device disconnected", PAD_L + plotW / 2, PAD_T + plotH / 2);
        ctx.textAlign = "left";
      }

      const laneH = lanes.length ? plotH / lanes.length : plotH;
      const amp = Math.min(laneH * 0.34, 26);

      lanes.forEach((gp, li) => {
        const cy = PAD_T + laneH * (li + 0.5);
        const yHi = cy - amp, yLo = cy + amp;
        const color = CHAN_COLORS[gp % CHAN_COLORS.length];

        // lane separator + label band
        ctx.strokeStyle = "#20202c";
        ctx.beginPath(); ctx.moveTo(PAD_L, PAD_T + laneH * (li + 1) + 0.5); ctx.lineTo(W - PAD_R, PAD_T + laneH * (li + 1) + 0.5); ctx.stroke();

        // label
        ctx.fillStyle = color;
        ctx.font = '600 11px "IBM Plex Mono", monospace';
        ctx.textAlign = "left";
        ctx.fillText(pinLabel(gp), 10, cy - 3);
        ctx.fillStyle = "#64748b";
        ctx.font = '9px "IBM Plex Mono", monospace';
        ctx.fillText(channelLabel(gp), 10, cy + 9);

        // sample the edge history across the window
        const sample = TcapiStore.history(gp).sampler();
        ctx.lineWidth = style === "scope" ? 2 : 1.4;
        ctx.strokeStyle = color;
        ctx.lineJoin = "round";

        if (style === "scope") {
          ctx.shadowColor = color; ctx.shadowBlur = 7;
        } else {
          ctx.shadowBlur = 0;
        }

        if (style === "filled") {
          ctx.beginPath();
          let prevV = -1;
          for (let px = 0; px <= plotW; px++) {
            const t = tStart + (px / plotW) * winUs;
            const v = sample(t);
            const x = PAD_L + px;
            const y = v ? yHi : yLo;
            if (px === 0) ctx.moveTo(x, yLo);
            if (v !== prevV && prevV !== -1) ctx.lineTo(x, yLo > yHi ? yLo : yHi);
            ctx.lineTo(x, y);
            prevV = v;
          }
          ctx.lineTo(PAD_L + plotW, yLo);
          ctx.closePath();
          ctx.fillStyle = color + "33";
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
        } else {
          ctx.beginPath();
          let prevV = -1, started = false;
          for (let px = 0; px <= plotW; px++) {
            const t = tStart + (px / plotW) * winUs;
            const v = sample(t);
            const x = PAD_L + px;
            const y = v ? yHi : yLo;
            if (!started) { ctx.moveTo(x, y); started = true; }
            else {
              if (v !== prevV) { ctx.lineTo(x, prevV ? yHi : yLo); ctx.lineTo(x, y); }
              else ctx.lineTo(x, y);
            }
            prevV = v;
          }
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
      });

      // ---- cursors ----
      const cur = S.cursors;
      cur.forEach((c, i) => {
        const x = xOf(c.t);
        if (x < PAD_L || x > W - PAD_R) return;
        ctx.strokeStyle = i === 0 ? "#fbbf24" : "#38bdf8";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x + 0.5, PAD_T); ctx.lineTo(x + 0.5, PAD_T + plotH); ctx.stroke();
        ctx.setLineDash([]);
        // handle
        ctx.fillStyle = i === 0 ? "#fbbf24" : "#38bdf8";
        ctx.beginPath();
        ctx.moveTo(x, PAD_T); ctx.lineTo(x - 5, PAD_T - 0); ctx.lineTo(x, PAD_T + 8); ctx.lineTo(x + 5, PAD_T); ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#0d0d15"; ctx.font = '700 9px "IBM Plex Mono"'; ctx.textAlign = "center";
        ctx.fillText(String(i + 1), x, PAD_T + 6);
        ctx.textAlign = "left";
      });

      // ---- time axis ----
      ctx.fillStyle = "#5b6577";
      ctx.font = '9px "IBM Plex Mono", monospace';
      ctx.textAlign = "center";
      for (let i = 0; i <= divs; i += 1) {
        const x = PAD_L + (i / divs) * plotW;
        const t = tStart + (i / divs) * winUs;
        if (i % 2 === 0) ctx.fillText((t / 1000).toFixed(2) + "m", x, H - 6);
      }
      ctx.textAlign = "left";

      // readout
      if (readoutRef.current) {
        const dt = Math.abs(cur[1].t - cur[0].t);
        const freq = dt > 0 ? (1e6 / dt) : 0;
        readoutRef.current.textContent =
          `C1 ${(cur[0].t / 1000).toFixed(3)}ms   C2 ${(cur[1].t / 1000).toFixed(3)}ms   ΔT ${dt.toFixed(1)}µs   1/ΔT ${freq >= 1000 ? (freq / 1000).toFixed(2) + "kHz" : freq.toFixed(0) + "Hz"}`;
      }

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // cursor dragging
  function onPointerDown(e: React.PointerEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const S = TcapiStore.get();
    const PAD_L = 92, PAD_R = 14;
    const plotW = rect.width - PAD_L - PAD_R;
    const winUs = S.windowUs;
    const tEnd = S.connStatus === "connected" ? S.streamT : winUs;
    const tStart = tEnd - winUs;
    const x = e.clientX - rect.left;
    // pick nearest cursor
    const xs = S.cursors.map((c) => PAD_L + ((c.t - tStart) / winUs) * plotW);
    const idx = Math.abs(x - xs[0]) < Math.abs(x - xs[1]) ? 0 : 1;
    dragRef.current = { idx, tStart, winUs, plotW, PAD_L };
    moveCursor(e.nativeEvent);
    window.addEventListener("pointermove", moveCursor);
    window.addEventListener("pointerup", up);
  }
  function moveCursor(e: PointerEvent) {
    const d = dragRef.current; if (!d) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(d.PAD_L, Math.min(rect.width - 14, e.clientX - rect.left));
    const t = d.tStart + ((x - d.PAD_L) / d.plotW) * d.winUs;
    TcapiStore.setCursor(d.idx, t);
  }
  function up() {
    dragRef.current = null;
    window.removeEventListener("pointermove", moveCursor);
    window.removeEventListener("pointerup", up);
  }

  const S = TcapiStore.get();
  const allInputs = TcapiStore.inputChannels();
  const outs = TcapiStore.outputChannels();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--border-soft)" }}>
        <span className="panel-title">Waveform</span>
        <span className="chip mono" style={{ color: "#22c55e" }}>{S.recording && S.connStatus === "connected" ? "● REC" : "◌ IDLE"}</span>
        <div style={{ flex: 1 }} />
        <span className="mono" ref={readoutRef} style={{ fontSize: 11, color: "var(--text-secondary)" }}></span>
        <div style={{ flex: 1 }} />
        <div className="seg">
          {[3000, 6000, 12000].map((w) => (
            <button key={w} className={S.windowUs === w ? "active" : ""} onClick={() => TcapiStore.setWindow(w)}>{w / 1000}ms</button>
          ))}
        </div>
        <button className="btn ghost sm" onClick={() => TcapiStore.setRecording(!S.recording)}>{S.recording ? "Pause" : "Rec"}</button>
        <button className="btn ghost sm" onClick={() => TcapiStore.clearWave()}>Clear</button>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div ref={wrapRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <canvas ref={canvasRef} onPointerDown={onPointerDown} style={{ position: "absolute", inset: 0, cursor: "ew-resize", display: "block" }}></canvas>
        </div>
        <div className="scroll-y" style={{ width: 132, borderLeft: "1px solid var(--border-soft)", padding: "8px 6px", display: "flex", flexDirection: "column", gap: 2 }}>
          <div className="eyebrow" style={{ padding: "2px 6px 4px" }}>Channels</div>
          {outs.filter((ch) => S.monitored.has(ch)).length > 0 && (
            <div className="eyebrow dim" style={{ padding: "4px 6px 2px", fontSize: 8.5 }}>Outputs</div>
          )}
          {outs.map((ch) => S.monitored.has(ch) ? (
            <ChanRow key={ch} ch={ch} on={true} color={CHAN_COLORS[ch % CHAN_COLORS.length]} />
          ) : null)}
          <div className="eyebrow dim" style={{ padding: "6px 6px 2px", fontSize: 8.5 }}>Inputs</div>
          {allInputs.map((ch) => (
            <ChanRow key={ch} ch={ch} on={S.monitored.has(ch)} color={CHAN_COLORS[ch % CHAN_COLORS.length]} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ChanRow({ ch, on, color }: { ch: number; on: boolean; color: string }) {
  return (
    <button
      onClick={() => TcapiStore.toggleMonitor(ch)}
      style={{
        display: "flex", alignItems: "center", gap: 7, padding: "4px 6px", borderRadius: 4,
        background: on ? "var(--surface-2)" : "transparent", border: "1px solid " + (on ? "var(--border-soft)" : "transparent"),
        cursor: "pointer", color: on ? "var(--text)" : "var(--text-dim)", textAlign: "left", width: "100%",
      }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: on ? color : "#2c2c3c", flex: "none", boxShadow: on ? "0 0 6px " + color + "88" : "none" }}></span>
      <span className="mono" style={{ fontSize: 10.5, fontWeight: 600 }}>{pinLabel(ch)}</span>
      <span className="mono" style={{ fontSize: 8.5, color: "var(--text-dim)", marginLeft: "auto" }}>{channelLabel(ch)}</span>
    </button>
  );
}
