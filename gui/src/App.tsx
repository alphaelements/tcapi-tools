// ============================================================
// App.tsx — Pochi Tools GUI shell + assembly
// Ported from design-reference app.jsx (mechanical ESM/TSX
// conversion). Differences from the mock: boot connects nothing
// automatically (scan only), and the View menu opens Settings
// (the mock's tweaks scaffold is not ported).
// ============================================================
import { useEffect, useRef, useState } from "react";
import { CommandLog } from "./components/panels-log";
import { DevicePanel } from "./components/panels-device";
import { GpioMonitor } from "./components/panels-gpio";
import { OutputControl, PinMapEditor } from "./components/panels-output-map";
import { PatternEditor, TimestampViewer } from "./components/panels-pattern-ts";
import { SettingsPanel, useTweaks } from "./components/settings";
import { WaveformViewer } from "./components/waveform";
import { NUM_PINS, PochiStore, useStore } from "./store/store";

const DENSITY: Record<string, { pad: string; gap: string; row: string; fs: string }> = {
  compact: { pad: "9px", gap: "7px", row: "26px", fs: "12.5px" },
  comfortable: { pad: "14px", gap: "10px", row: "30px", fs: "13px" },
};
const LAYOUT_GPIO: Record<string, number> = { monitor: 0.52, split: 0.42, scope: 0.30 };

// ---------- resizer ----------
function Resizer({ dir, onDelta }: { dir: "x" | "y"; onDelta: (d: number) => void }) {
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = dir === "x" ? e.clientX : e.clientY;
    let last = start;
    const move = (ev: PointerEvent) => { const c = dir === "x" ? ev.clientX : ev.clientY; onDelta(c - last); last = c; };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.cursor = ""; };
    document.body.style.cursor = dir === "x" ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const isX = dir === "x";
  return (
    <div onPointerDown={down} style={{
      flex: "none", [isX ? "width" : "height"]: 6, cursor: isX ? "col-resize" : "row-resize",
      background: "var(--bg)", position: "relative", zIndex: 5,
    }}>
      <div style={{ position: "absolute", inset: isX ? "0 2px" : "2px 0", background: "var(--border-soft)" }}></div>
    </div>
  );
}

// ---------- menu bar ----------
function MenuBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  useStore(["conn"]);
  const S = PochiStore.get();
  const menus = ["File", "View", "Device", "Tools", "Help"];
  const [open, setOpen] = useState<string | null>(null);
  const connected = S.connStatus === "connected";
  return (
    <div style={{ display: "flex", alignItems: "center", height: 38, background: "var(--surface)", borderBottom: "1px solid var(--border)", padding: "0 10px", gap: 4, flex: "none", WebkitAppRegion: "drag" } as React.CSSProperties}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 12 }}>
        <Logo />
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: ".01em" }}>Pochi Tools</span>
      </div>
      <div style={{ display: "flex", gap: 1, position: "relative" }}>
        {menus.map((m) => (
          <button key={m} onMouseEnter={() => open !== null && setOpen(m)} onClick={() => setOpen(open === m ? null : m)}
            style={{ background: open === m ? "var(--surface-hover)" : "transparent", border: 0, color: "var(--text-secondary)", fontSize: 12.5, padding: "5px 10px", borderRadius: 5, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
            {m}
          </button>
        ))}
        {open === "View" && (
          <div className="card" style={{ position: "absolute", top: 30, left: 44, zIndex: 30, padding: 4, minWidth: 130 }}>
            <button className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start" }}
              onClick={() => { setOpen(null); onOpenSettings(); }}>
              Settings…
            </button>
          </div>
        )}
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginRight: 10, padding: "3px 10px", borderRadius: 20, background: "var(--surface-2)", border: "1px solid var(--border-soft)" }}>
        <span className={"dot-led " + (connected ? "on" : S.connStatus === "connecting" ? "busy" : "low")}></span>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{connected ? S.devices.find((d) => d.uid === S.connectedUid)?.port.replace("/dev/", "") : "no link"}</span>
      </div>
      <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
        {["#fbbf24", "#22c55e", "#ef4444"].map((c, i) => (
          <span key={i} style={{ width: 11, height: 11, borderRadius: "50%", background: c, opacity: .85 }}></span>
        ))}
      </div>
      {open && <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, zIndex: 1 }}></div>}
    </div>
  );
}

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="var(--accent)" opacity="0.18" />
      <rect x="1.5" y="1.5" width="17" height="17" rx="4" stroke="var(--accent)" strokeWidth="1.3" />
      <path d="M3 12h3l1.5-5 2 8 2-6 1.5 3H17" stroke="var(--accent)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- right sidebar tabs ----------
function RightDock() {
  useStore(["conn", "pattern"]);
  const [tab, setTab] = useState("output");
  const tabs: [string, string, () => React.JSX.Element][] = [
    ["output", "Output", OutputControl],
    ["map", "Pin Map", PinMapEditor],
    ["pattern", "Pattern", PatternEditor],
    ["ts", "Timestamp", TimestampViewer],
  ];
  const entry = tabs.find((t) => t[0] === tab) ?? tabs[0];
  const Active = entry[2];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--surface)" }}>
      <div style={{ display: "flex", borderBottom: "1px solid var(--border-soft)", flex: "none" }}>
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            flex: 1, padding: "9px 4px", background: tab === id ? "var(--surface)" : "var(--surface-2)",
            border: 0, borderBottom: "2px solid " + (tab === id ? "var(--accent)" : "transparent"),
            color: tab === id ? "var(--text)" : "var(--text-secondary)", fontSize: 11, fontWeight: 600, cursor: "pointer",
            fontFamily: "var(--font-sans)", letterSpacing: ".01em",
          }}>{label}</button>
        ))}
      </div>
      <div className="scroll-y" style={{ flex: 1, padding: 12, minHeight: 0 }}>
        <Active />
      </div>
    </div>
  );
}

// ---------- status bar ----------
function StatusBar({ fps }: { fps: number }) {
  useStore(["conn", "pins", "sim", "map"]);
  const S = PochiStore.get();
  const connected = S.connStatus === "connected";
  const outCount = PochiStore.outputChannels().length;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, height: 24, flex: "none", background: "var(--surface)", borderTop: "1px solid var(--border)", fontSize: 10.5, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
      <SbItem accent>{connected ? "● " + (S.version ? "fw " + S.version.fw : "") : "○ offline"}</SbItem>
      <SbItem>map {outCount}o/{NUM_PINS - outCount}i</SbItem>
      <SbItem>sub {S.subscribed ? "ON" : "off"}</SbItem>
      <SbItem>t {(S.streamT / 1000).toFixed(1)}ms</SbItem>
      <SbItem>scope {S.monitored.size}ch</SbItem>
      <div style={{ flex: 1 }} />
      <SbItem>{fps} fps</SbItem>
      <SbItem>{"tick " + PochiStore.tickNs() + " ns"}</SbItem>
      <SbItem accent>Pochi-DIO SDK 0.1.0</SbItem>
    </div>
  );
}
function SbItem({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return <span style={{ padding: "0 11px", borderRight: "1px solid var(--border-soft)", color: accent ? "var(--accent)" : "inherit", display: "flex", alignItems: "center", height: "100%" }}>{children}</span>;
}

// ---------- app ----------
function App() {
  const [t, setTweak] = useTweaks();
  const [leftW, setLeftW] = useState(212);
  const [rightW, setRightW] = useState(340);
  const [logH, setLogH] = useState(156);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [gpioPct, setGpioPct] = useState(LAYOUT_GPIO[t.layout] ?? 0.4);
  const [fps, setFps] = useState(60);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const centerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setGpioPct(LAYOUT_GPIO[t.layout] ?? 0.4); }, [t.layout]);

  // boot: start the stream clock + event listeners, then auto-scan
  useEffect(() => {
    PochiStore.startLoop();
    void PochiStore.scan();
  }, []);

  // fps meter
  useEffect(() => {
    let frames = 0, last = performance.now(), raf: number;
    const loop = (now: number) => { frames++; if (now - last >= 500) { setFps(Math.round(frames / ((now - last) / 1000))); frames = 0; last = now; } raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const d = DENSITY[t.density] || DENSITY.comfortable;
  const rootStyle = {
    height: "100%", display: "flex", flexDirection: "column",
    background: "var(--bg)",
    "--accent": t.accent,
    "--accent-hover": `color-mix(in oklab, ${t.accent} 78%, #000)`,
    "--pad": d.pad, "--gap": d.gap, "--row-h": d.row,
    fontSize: d.fs,
  } as React.CSSProperties;

  return (
    <div style={rootStyle}>
      <MenuBar onOpenSettings={() => setSettingsOpen(true)} />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* left */}
        <div style={{ width: leftW, flex: "none", background: "var(--surface)", borderRight: "0", minWidth: 0 }}>
          <DevicePanel />
        </div>
        <Resizer dir="x" onDelta={(dx) => setLeftW((w) => Math.max(170, Math.min(320, w + dx)))} />
        {/* center */}
        <div ref={centerRef} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
          <div style={{ flex: gpioPct, minHeight: 70, background: "var(--surface)", display: "flex" }}>
            <GpioMonitor tweaks={t} />
          </div>
          <Resizer dir="y" onDelta={(dy) => {
            const h = centerRef.current?.clientHeight || 600;
            setGpioPct((p) => Math.max(0.12, Math.min(0.8, p + dy / h)));
          }} />
          <div style={{ flex: 1 - gpioPct, minHeight: 90, background: "var(--surface)", display: "flex" }}>
            <WaveformViewer tweaks={t} />
          </div>
        </div>
        <Resizer dir="x" onDelta={(dx) => setRightW((w) => Math.max(210, Math.min(380, w - dx)))} />
        {/* right */}
        <div style={{ width: rightW, flex: "none", minWidth: 0 }}>
          <RightDock />
        </div>
      </div>
      {/* bottom log */}
      {!logCollapsed && <Resizer dir="y" onDelta={(dy) => setLogH((h) => Math.max(90, Math.min(360, h - dy)))} />}
      <div style={{ height: logCollapsed ? 34 : logH, flex: "none", borderTop: "1px solid var(--border)" }}>
        <CommandLog collapsed={logCollapsed} onToggle={() => setLogCollapsed((c) => !c)} />
      </div>
      <StatusBar fps={fps} />

      {settingsOpen && <SettingsPanel tweaks={t} setTweak={setTweak} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

export default App;
