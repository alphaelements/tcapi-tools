// ============================================================
// panels-safety.tsx — safety UI (watchdog, failsafe latch, exclusive
// groups, safety.toml)
//
// Not part of the design-reference prototype (it predates the safety
// functions); built from the same theme classes and tokens. Everything the
// device decides (latch, groups, watchdog) comes from the Tauri backend; the
// safety.toml is evaluated and applied by the backend (`safety_load_toml`,
// `apply_safety`), never in the frontend.
//
//  * SafetyBanners — global strip under the menu bar: the FAILSAFE banner
//    (outputs to default, release with confirmation), an exclusive-group
//    violation by pin name, and a failed watchdog heartbeat.
//  * SafetyPanel   — the "Safety" tab.
//  * OutputsDefaultButton — shared "outputs reset" button.
//
// Every control is hidden for firmware without the matching `caps feat=` bit.
// ============================================================
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  MAX_EXCLUSIVE_GROUPS,
  WDOG_MAX_MS,
  WDOG_MIN_MS,
  describeCause,
  groupMask,
  heartbeatIntervalMs,
  maskPins,
  validateWdogInput,
} from "../lib/safety";
import { pinLabel } from "../lib/pins";
import { tauriAvailable } from "../lib/tauri";
import { TcapiStore, useStore } from "../store/store";

const ALERT_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "7px 12px",
  fontSize: 12,
  flex: "none",
} as const;

// ---------------- confirmation ----------------

/// Modal yes/no. An in-app dialog (not `window.confirm`, which a webview may
/// suppress) so the confirmation is always shown and can be tested.
function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel }: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div role="dialog" aria-modal="true" aria-label={title} data-testid="confirm-dialog" onClick={(e) => e.stopPropagation()} className="card"
        style={{ width: 360, padding: 16, display: "flex", flexDirection: "column", gap: 12, boxShadow: "0 16px 40px -12px rgba(0,0,0,.7)" }}>
        <span className="panel-title">{title}</span>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 }}>{children}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn sm" data-testid="confirm-cancel" onClick={onCancel}>Cancel</button>
          <button className="btn sm primary" data-testid="confirm-ok" autoFocus onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

/// "Release failsafe…" with its confirmation. The release itself is the
/// store's `clearFailsafe`; the outputs stay at their defaults.
function ReleaseFailsafe({ compact }: { compact?: boolean }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button className={"btn sm" + (compact ? "" : " primary")} data-testid="failsafe-release" onClick={() => setAsking(true)}>
        Release failsafe…
      </button>
      {asking && (
        <ConfirmDialog title="Release the failsafe latch?" confirmLabel="Release"
          onCancel={() => setAsking(false)}
          onConfirm={() => { setAsking(false); void TcapiStore.clearFailsafe(); }}>
          The outputs stay at their default state. After the release the device accepts output
          changes again, and an enabled watchdog trips again if the host stops answering.
        </ConfirmDialog>
      )}
    </>
  );
}

/// `outputs reset`: every output to its default state. Never blocked by a
/// pattern, a latch or an exclusive group, so it is enabled whenever a
/// device with the feature is connected.
export function OutputsDefaultButton({ className = "btn sm", style }: { className?: string; style?: React.CSSProperties }) {
  useStore(["conn"]);
  const S = TcapiStore.get();
  if (!TcapiStore.safetyFeatures().outputsReset) return null;
  return (
    <button className={className} style={style} data-testid="outputs-default" disabled={S.connStatus !== "connected"}
      title="Return every output to its default state (outputs reset); stops a running pattern"
      onClick={() => void TcapiStore.resetOutputs()}>
      Outputs to default
    </button>
  );
}

// ---------------- banners ----------------

export function SafetyBanners() {
  useStore(["safety", "conn"]);
  const S = TcapiStore.get();
  const feat = TcapiStore.safetyFeatures();
  if (S.connStatus !== "connected" || !feat.any) return null;
  const st = S.safety.state;
  const { violation, heartbeat, heartbeatError } = S.safety;
  const latched = st?.failsafe === true;

  return (
    <>
      {latched && st && (
        <div role="alert" data-testid="failsafe-banner" style={{ ...ALERT_STYLE, background: "color-mix(in oklab, var(--warn) 22%, var(--surface))", borderBottom: "1px solid var(--warn)" }}>
          <span className="dot-led err"></span>
          <strong className="mono" style={{ letterSpacing: ".08em" }}>FAILSAFE</strong>
          <span data-testid="failsafe-cause" className="mono" style={{ color: "#fecaca" }}>cause: {st.cause}</span>
          <span style={{ color: "var(--text-secondary)", flex: 1 }}>{describeCause(st.cause)} Outputs are at their default state.</span>
          <OutputsDefaultButton />
          {feat.watchdog && <ReleaseFailsafe />}
        </div>
      )}
      {violation && (
        <div role="alert" data-testid="excl-violation" style={{ ...ALERT_STYLE, background: "color-mix(in oklab, #fbbf24 14%, var(--surface))", borderBottom: "1px solid #fbbf24" }}>
          <strong className="mono">EXCLUSIVE</strong>
          <span style={{ flex: 1 }}>
            Refused: exclusive group {violation.group} allows one pin ON at a time ({maskPins(violation.mask).join(", ")})
            <span className="mono dim"> · mask 0x{violation.mask.toString(16).padStart(8, "0")}</span>
          </span>
          <button className="btn ghost sm" aria-label="Dismiss" onClick={() => TcapiStore.dismissViolation()}>×</button>
        </div>
      )}
      {heartbeat === "failed" && (
        <div role="alert" data-testid="heartbeat-failed" style={{ ...ALERT_STYLE, background: "color-mix(in oklab, #fbbf24 14%, var(--surface))", borderBottom: "1px solid #fbbf24" }}>
          <strong className="mono">HEARTBEAT</strong>
          <span style={{ flex: 1 }}>
            Watchdog heartbeat stopped{heartbeatError ? `: ${heartbeatError}` : ""}. The device trips the failsafe when the watchdog expires.
          </span>
          {st && st.wdog_ms > 0 && !latched && (
            <button className="btn sm" data-testid="heartbeat-restart" onClick={() => void TcapiStore.setWatchdog(st.wdog_ms)}>Restart heartbeat</button>
          )}
        </div>
      )}
    </>
  );
}

// ---------------- Safety tab ----------------

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22 }}>
      <span style={{ fontSize: 11.5, color: "var(--text-secondary)", width: 92, flex: "none" }}>{label}</span>
      <span className="mono" data-testid={testId} style={{ fontSize: 11.5, flex: 1, minWidth: 0 }}>{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <span className="eyebrow">{title}</span>
      {children}
    </div>
  );
}

function WatchdogControls() {
  useStore(["safety"]);
  const S = TcapiStore.get();
  const st = S.safety.state;
  const [text, setText] = useState("1000");
  const parsed = validateWdogInput(text);
  const hb = S.safety.heartbeat;
  return (
    <Section title="Watchdog">
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input className="field" aria-label="Watchdog timeout (ms)" data-testid="wdog-input" value={text}
          onChange={(e) => setText(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <span className="mono dim" style={{ fontSize: 10.5 }}>ms</span>
        <button className="btn sm primary" data-testid="wdog-enable" disabled={!parsed.ok || parsed.ms === 0}
          onClick={() => parsed.ok && void TcapiStore.setWatchdog(parsed.ms)}>Enable</button>
        <button className="btn sm" data-testid="wdog-disable" disabled={!st || st.wdog_ms === 0}
          onClick={() => void TcapiStore.setWatchdog(0)}>Disable</button>
      </div>
      <span className="mono" data-testid="wdog-error" style={{ fontSize: 10.5, color: parsed.ok ? "var(--text-dim)" : "#fbbf24" }}>
        {parsed.ok ? `0 = off, ${WDOG_MIN_MS}–${WDOG_MAX_MS} ms` : parsed.error}
      </span>
      <div data-testid="heartbeat-status" data-state={hb} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
        <span className={"dot-led " + (hb === "running" ? "on" : hb === "failed" ? "err" : "low")}></span>
        {hb === "running" && st && (
          <span>Heartbeat running <span className="mono dim">· ping every {heartbeatIntervalMs(st.wdog_ms)} ms</span></span>
        )}
        {hb === "off" && <span style={{ color: "var(--text-secondary)" }}>Heartbeat off (watchdog disabled)</span>}
        {hb === "failed" && <span style={{ color: "#fbbf24" }}>Heartbeat failed{S.safety.heartbeatError ? `: ${S.safety.heartbeatError}` : ""}</span>}
      </div>
    </Section>
  );
}

function ExclusiveControls() {
  useStore(["safety", "map"]);
  const S = TcapiStore.get();
  const groups = S.safety.groups;
  const outs = TcapiStore.outputChannels();
  const [picked, setPicked] = useState<number[]>([]);
  const toggle = (ch: number) =>
    setPicked((p) => (p.includes(ch) ? p.filter((c) => c !== ch) : [...p, ch].sort((a, b) => a - b)));
  const canAdd = picked.length >= 2 && groups.length < MAX_EXCLUSIVE_GROUPS;
  return (
    <Section title="Exclusive groups">
      {groups.length === 0 && <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>No group: any combination of outputs is allowed.</span>}
      <div data-testid="excl-groups" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {groups.map((mask, i) => (
          <div key={i} data-testid={`excl-group-${i}`} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: "var(--r-sm)", background: "var(--surface-2)", border: "1px solid var(--border-soft)" }}>
            <span className="mono dim" style={{ fontSize: 10.5, width: 18 }}>#{i}</span>
            <span className="mono" style={{ fontSize: 11, flex: 1, minWidth: 0 }}>{maskPins(mask).join(", ")}</span>
            <button className="btn ghost sm" aria-label={`Remove group ${i}`} data-testid={`excl-remove-${i}`}
              onClick={() => void TcapiStore.setExclusiveGroups(groups.filter((_, k) => k !== i))}>×</button>
          </div>
        ))}
      </div>
      {outs.length >= 2 ? (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {outs.map((ch) => (
              <button key={ch} className={"chip" + (picked.includes(ch) ? " out" : "")} data-testid={`excl-pick-${ch}`}
                aria-pressed={picked.includes(ch)} onClick={() => toggle(ch)}
                style={{ cursor: "pointer", background: picked.includes(ch) ? "var(--surface-hover)" : undefined }}>
                {pinLabel(ch)}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn sm primary" data-testid="excl-add" disabled={!canAdd}
              onClick={() => {
                void TcapiStore.setExclusiveGroups([...groups, groupMask(picked)]);
                setPicked([]);
              }}>Add group</button>
            <button className="btn sm" data-testid="excl-clear" disabled={groups.length === 0}
              onClick={() => void TcapiStore.setExclusiveGroups([])}>Clear all</button>
          </div>
        </>
      ) : (
        <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>A group needs at least two output pins.</span>
      )}
    </Section>
  );
}

function SafetyFile() {
  useStore(["safety"]);
  const S = TcapiStore.get();
  const { fileError, applied } = S.safety;

  async function pick() {
    if (!tauriAvailable) {
      TcapiStore.addLog("error", "safety.toml: file dialog requires the Tauri runtime");
      return;
    }
    const path = await open({ filters: [{ name: "TOML", extensions: ["toml"] }], multiple: false });
    if (typeof path === "string") await TcapiStore.applySafetyFile(path);
  }

  return (
    <Section title="safety.toml">
      <button className="btn sm" data-testid="safety-apply-file" style={{ justifyContent: "center" }} onClick={() => void pick()}>
        Apply safety.toml…
      </button>
      {fileError && (
        <div role="alert" data-testid="safety-file-error" className="mono" style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 10.5, lineHeight: 1.5, color: "#fecaca", background: "color-mix(in oklab, var(--warn) 14%, var(--surface-2))", border: "1px solid color-mix(in oklab, var(--warn) 40%, var(--border))", borderRadius: "var(--r-sm)", padding: "6px 8px", wordBreak: "break-word" }}>
          <span style={{ flex: 1 }}>{fileError}</span>
          <button className="btn ghost sm" aria-label="Dismiss" style={{ padding: "0 4px" }} onClick={() => TcapiStore.dismissFileError()}>×</button>
        </div>
      )}
      {applied && !fileError && (
        <span data-testid="safety-applied" className="mono" style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
          applied: watchdog {applied.watchdog_ms === 0 ? "off" : `${applied.watchdog_ms} ms`}, usbsafe {applied.usbsafe ? "on" : "off"}, {applied.groups.length} group{applied.groups.length === 1 ? "" : "s"}
        </span>
      )}
    </Section>
  );
}

export function SafetyPanel() {
  useStore(["safety", "conn"]);
  const S = TcapiStore.get();
  const feat = TcapiStore.safetyFeatures();
  if (S.connStatus !== "connected" || !feat.any) {
    return <div style={{ fontSize: 11.5, color: "var(--text-dim)", padding: "10px 4px", lineHeight: 1.5 }}>Connect a device with safety functions.</div>;
  }
  const st = S.safety.state;
  const latched = st?.failsafe === true;
  return (
    <div data-testid="safety-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {feat.watchdog && (
        <Section title="State">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <Row label="Failsafe" testId="safety-latch">
              <span className={"dot-led " + (latched ? "err" : "on")} style={{ marginRight: 6 }}></span>
              {latched ? `LATCHED (${st?.cause})` : "clear"}
            </Row>
            <Row label="Watchdog" testId="safety-wdog">{st ? (st.wdog_ms === 0 ? "off" : `${st.wdog_ms} ms`) : "—"}</Row>
            <Row label="Remaining" testId="safety-remaining">{st && st.wdog_ms > 0 && !latched ? `${st.remaining_ms} ms` : "—"}</Row>
            {feat.usbsafe && <Row label="USB safe" testId="safety-usbsafe">{st ? (st.usbsafe ? "on" : "off") : "—"}</Row>}
            {feat.exclusive && <Row label="Groups" testId="safety-excl">{st ? st.excl : "—"}</Row>}
          </div>
          <button className="btn sm" data-testid="safety-refresh" style={{ justifyContent: "center" }} onClick={() => void TcapiStore.refreshSafety()}>Refresh</button>
        </Section>
      )}

      <Section title="Outputs">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <OutputsDefaultButton className="btn sm primary" />
          {feat.watchdog && latched && <ReleaseFailsafe compact />}
        </div>
      </Section>

      {feat.watchdog && <WatchdogControls />}

      {feat.usbsafe && (
        <Section title="USB link">
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "var(--text-secondary)" }}>
            <span className={"switch " + (st?.usbsafe ? "on" : "")} role="switch" aria-checked={st?.usbsafe === true} aria-label="USB safe" data-testid="usbsafe-switch" tabIndex={0}
              onClick={() => void TcapiStore.setUsbsafe(!(st?.usbsafe === true))}
              onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); void TcapiStore.setUsbsafe(!(st?.usbsafe === true)); } }}></span>
            Failsafe when the USB link is lost
          </label>
        </Section>
      )}

      {feat.exclusive && <ExclusiveControls />}

      {feat.applyFile && <SafetyFile />}
    </div>
  );
}
