// ============================================================
// settings.tsx — appearance settings (the Settings feature)
//
// The mock's TweaksPanel scaffold is not ported (per the reuse
// guide); only the option set and defaults from app.jsx's
// TWEAK_DEFAULTS carry over. Settings persist in localStorage
// and open from the View menu.
// ============================================================
import { useState } from "react";

export const TWEAK_DEFAULTS = {
  accent: "#7c3aed",
  layout: "scope",
  density: "comfortable",
  pinLayout: "grid",
  pinShape: "circle",
  waveformStyle: "scope",
};

export type Tweaks = typeof TWEAK_DEFAULTS;
export type TweakKey = keyof Tweaks;

const STORAGE_KEY = "pochi-tweaks";

function loadTweaks(): Tweaks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...TWEAK_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Tweaks>;
    return { ...TWEAK_DEFAULTS, ...parsed };
  } catch {
    return { ...TWEAK_DEFAULTS };
  }
}

export function useTweaks(): [Tweaks, (key: TweakKey, value: string) => void] {
  const [tweaks, setTweaks] = useState<Tweaks>(loadTweaks);
  const setTweak = (key: TweakKey, value: string) => {
    setTweaks((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private mode: settings stay session-local */
      }
      return next;
    });
  };
  return [tweaks, setTweak];
}

const OPTIONS: { key: TweakKey; label: string; section: string; values: string[] }[] = [
  { key: "layout", label: "Center balance", section: "Layout", values: ["monitor", "split", "scope"] },
  { key: "density", label: "Density", section: "Layout", values: ["compact", "comfortable"] },
  { key: "pinLayout", label: "Pin arrangement", section: "GPIO Monitor", values: ["row", "rows2", "grid"] },
  { key: "pinShape", label: "Pin shape", section: "GPIO Monitor", values: ["circle", "square", "led"] },
  { key: "waveformStyle", label: "Trace style", section: "Waveform", values: ["scope", "minimal", "filled"] },
];

const ACCENTS = ["#7c3aed", "#0ea5e9", "#3b82f6", "#ec4899", "#14b8a6"];

export function SettingsPanel({ tweaks, setTweak, onClose }: {
  tweaks: Tweaks;
  setTweak: (key: TweakKey, value: string) => void;
  onClose: () => void;
}) {
  let lastSection = "";
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,.35)" }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{
        position: "absolute", top: 46, right: 12, width: 280, padding: 14,
        display: "flex", flexDirection: "column", gap: 10,
        boxShadow: "0 16px 40px -12px rgba(0,0,0,.6)",
      }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <span className="panel-title">Settings</span>
          <button className="btn ghost icon sm" style={{ marginLeft: "auto", width: 22, height: 22 }} onClick={onClose}>×</button>
        </div>
        {OPTIONS.map((opt) => {
          const header = opt.section !== lastSection ? opt.section : null;
          lastSection = opt.section;
          return (
            <div key={opt.key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {header && <span className="eyebrow" style={{ marginTop: 4 }}>{header}</span>}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11.5, color: "var(--text-secondary)", flex: 1 }}>{opt.label}</span>
                <div className="seg">
                  {opt.values.map((v) => (
                    <button key={v} className={tweaks[opt.key] === v ? "active" : ""} onClick={() => setTweak(opt.key, v)}>{v}</button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="eyebrow" style={{ marginTop: 4 }}>Theme</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)", flex: 1 }}>Accent</span>
            <div style={{ display: "flex", gap: 6 }}>
              {ACCENTS.map((c) => (
                <button key={c} onClick={() => setTweak("accent", c)} style={{
                  width: 18, height: 18, borderRadius: "50%", background: c, cursor: "pointer",
                  border: "2px solid " + (tweaks.accent === c ? "#fff" : "transparent"),
                  boxShadow: tweaks.accent === c ? `0 0 8px ${c}aa` : "none", padding: 0,
                }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
