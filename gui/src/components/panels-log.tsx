// ============================================================
// panels-log.tsx — CommandLog / REPL console (bottom bar)
// Ported from design-reference panels-log.jsx (mechanical
// ESM/TSX conversion; raw() now reaches the device).
// ============================================================
import { useEffect, useRef, useState } from "react";
import { fmt, LogDirection, PochiStore, useStore } from "../store/store";

const DIR_STYLE: Record<LogDirection, { prefix: string; color: string; text: string }> = {
  sent: { prefix: ">", color: "var(--accent)", text: "#c4b5fd" },
  received: { prefix: "<", color: "var(--text-secondary)", text: "var(--text)" },
  event: { prefix: "!", color: "#38bdf8", text: "#7dd3fc" },
  error: { prefix: "✕", color: "var(--warn)", text: "#fecaca" },
};

export function CommandLog({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  useStore(["log", "conn"]);
  const S = PochiStore.get();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [auto, setAuto] = useState(true);
  const [input, setInput] = useState("");
  const histRef = useRef<string[]>([]);
  const hi = useRef(-1);

  useEffect(() => {
    if (auto && scrollRef.current && !collapsed) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  });

  function submit() {
    if (!input.trim()) return;
    histRef.current.push(input);
    hi.current = histRef.current.length;
    void PochiStore.raw(input);
    setInput("");
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") submit();
    else if (e.key === "ArrowUp") { if (hi.current > 0) { hi.current--; setInput(histRef.current[hi.current] || ""); } }
    else if (e.key === "ArrowDown") { if (hi.current < histRef.current.length - 1) { hi.current++; setInput(histRef.current[hi.current] || ""); } else { hi.current = histRef.current.length; setInput(""); } }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--scope-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", borderBottom: "1px solid var(--border-soft)", background: "var(--surface)" }}>
        <button className="btn ghost sm" onClick={onToggle} style={{ padding: "2px 4px" }}>
          <span style={{ display: "inline-block", transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform .15s", fontSize: 9 }}>▼</span>
        </button>
        <span className="panel-title">Command Log</span>
        <span className="chip mono">{S.log.length}</span>
        <div style={{ flex: 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--text-secondary)", cursor: "pointer" }}>
          <span className={"switch " + (auto ? "on" : "")} onClick={() => setAuto(!auto)} style={{ transform: "scale(.72)" }}></span>
          autoscroll
        </label>
        <button className="btn ghost sm" onClick={() => { void navigator.clipboard?.writeText(S.log.map((e) => `${DIR_STYLE[e.direction].prefix} ${e.text}`).join("\n")); }}>Copy</button>
        <button className="btn ghost sm" onClick={() => PochiStore.clearLog()}>Clear</button>
      </div>
      {!collapsed && (
        <>
          <div ref={scrollRef} className="scroll-y mono" style={{ flex: 1, padding: "8px 12px", fontSize: 11.5, lineHeight: 1.65 }}
            onWheel={() => { if (auto) setAuto(false); }}>
            {S.log.length === 0 && <div style={{ color: "var(--text-dim)" }}>— no traffic —</div>}
            {S.log.map((e) => {
              const d = DIR_STYLE[e.direction];
              return (
                <div key={e.id} style={{ display: "flex", gap: 8, whiteSpace: "pre-wrap" }}>
                  <span style={{ color: "var(--text-dim)", flex: "none", fontSize: 10 }}>{fmt.time(e.ts)}</span>
                  <span style={{ color: d.color, flex: "none", width: 10, fontWeight: 700 }}>{d.prefix}</span>
                  <span style={{ color: d.text }}>{e.text.replace(/^[><!]\s*/, "")}</span>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderTop: "1px solid var(--border-soft)" }}>
            <span className="mono" style={{ color: "var(--accent)", fontWeight: 700 }}>$</span>
            <input className="mono" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey}
              placeholder={S.connStatus === "connected" ? "type a command (read, state, version, caps…)" : "connect a device to send commands"}
              disabled={S.connStatus !== "connected"}
              style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "var(--text)", fontSize: 12 }} />
            <span className="mono dim" style={{ fontSize: 9.5 }}>↑↓ history · ⏎ send</span>
          </div>
        </>
      )}
    </div>
  );
}
