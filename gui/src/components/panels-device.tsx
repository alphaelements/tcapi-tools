// ============================================================
// panels-device.tsx — DevicePanel (left sidebar)
// Ported from design-reference panels-device.jsx (mechanical
// ESM/TSX conversion; structure and inline styles unchanged).
// ============================================================
import { useState } from "react";
import { DeviceEntry, TcapiStore, useStore } from "../store/store";

function StatusPill() {
  useStore(["conn"]);
  const S = TcapiStore.get();
  const map = {
    disconnected: ["low", "Disconnected"],
    connecting: ["busy", "Connecting…"],
    connected: ["on", "Connected"],
    error: ["err", "Error"],
  } as const;
  const [cls, label] = map[S.connStatus];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span className={"dot-led " + cls}></span>
      <span style={{ fontSize: 11.5, fontWeight: 500, color: cls === "on" ? "var(--high)" : "var(--text-secondary)" }}>{label}</span>
    </div>
  );
}

function DeviceCard({ dev }: { dev: DeviceEntry }) {
  const S = TcapiStore.get();
  const selected = S.selectedUid === dev.uid;
  const connected = S.connectedUid === dev.uid;
  return (
    <div
      onClick={() => TcapiStore.select(dev.uid)}
      onDoubleClick={() => void TcapiStore.connect(dev.uid)}
      style={{
        padding: "10px 11px", borderRadius: "var(--r-md)", cursor: "pointer",
        background: selected ? "var(--surface-hover)" : "var(--surface-2)",
        border: "1px solid " + (connected ? "var(--high)" : selected ? "color-mix(in oklab, var(--accent) 55%, var(--border))" : "var(--border-soft)"),
        boxShadow: connected ? "0 0 0 1px color-mix(in oklab, var(--high) 30%, transparent), 0 0 16px -6px var(--high-glow)" : "none",
        transition: "background .12s, border-color .12s",
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className={"dot-led " + (connected ? "on" : "low")}></span>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>Tcapi-DIO #{dev.num ?? "?"}</span>
        <span className="chip mono" style={{ marginLeft: "auto" }}>{dev.port.replace("/dev/", "")}</span>
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 7, display: "flex", justifyContent: "space-between" }}>
        <span>UID {dev.uid.slice(0, 8)}…</span>
        <span>fw {dev.fw ?? "—"}</span>
      </div>
      {connected && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-soft)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 8px" }}>
          <Info k="proto" v={S.version?.proto} />
          <Info k="pins" v={S.capabilities?.pins} />
          <Info k="tick" v={S.capabilities?.tickNs + " ns"} />
          <Info k="pattern" v={S.capabilities?.maxPattern} />
        </div>
      )}
    </div>
  );
}
function Info({ k, v }: { k: string; v: string | number | undefined }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span className="eyebrow" style={{ fontSize: 8.5 }}>{k}</span>
      <span className="mono" style={{ fontSize: 11, color: "var(--text)" }}>{v}</span>
    </div>
  );
}

function ResetMenu({ onClose }: { onClose: () => void }) {
  const [confirm, setConfirm] = useState<null | "pattern" | "system" | "bootsel">(null);

  async function run() {
    if (confirm === "pattern") await TcapiStore.patternReset();
    else if (confirm === "system") await TcapiStore.systemReset();
    else if (confirm === "bootsel") await TcapiStore.bootselReset();
    setConfirm(null);
    onClose();
  }

  if (confirm) {
    const labels = {
      pattern: ["Pattern reset", "Stop the pattern engine and clear the loaded buffer. USB stays up."],
      system: ["System reset", "Reboot the device (SCB::sys_reset). USB will re-enumerate — you must reconnect."],
      bootsel: ["BOOTSEL reset", "Reboot into BOOTSEL mass-storage mode for UF2 reflash. The device leaves normal operation."],
    } as const;
    const [title, body] = labels[confirm];
    const danger = confirm !== "pattern";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, borderRadius: "var(--r-md)", background: "var(--surface-2)", border: "1px solid " + (danger ? "var(--err)" : "var(--border))") }}>
        <div style={{ fontWeight: 600, fontSize: 12 }}>{title}?</div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4 }}>{body}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <button className={"btn " + (danger ? "danger" : "primary")} style={{ flex: 1, justifyContent: "center" }} onClick={() => void run()}>Confirm</button>
          <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, borderRadius: "var(--r-md)", background: "var(--surface-2)", border: "1px solid var(--border-soft)" }}>
      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 2 }}>Reset</div>
      <button className="btn" style={{ justifyContent: "center", fontSize: 11.5 }} onClick={() => setConfirm("pattern")}>Pattern reset</button>
      <button className="btn danger" style={{ justifyContent: "center", fontSize: 11.5 }} onClick={() => setConfirm("system")}>System reset</button>
      <button className="btn danger" style={{ justifyContent: "center", fontSize: 11.5 }} onClick={() => setConfirm("bootsel")}>BOOTSEL</button>
      <button className="btn" style={{ justifyContent: "center", fontSize: 10.5, opacity: 0.7 }} onClick={onClose}>Close</button>
    </div>
  );
}

export function DevicePanel() {
  useStore(["conn"]);
  const S = TcapiStore.get();
  const isConn = S.connStatus === "connected";
  const hasReset = isConn && (S.capabilities?.reset ?? false);
  const sel = S.selectedUid;
  const [showReset, setShowReset] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "11px 12px 9px", borderBottom: "1px solid var(--border-soft)" }}>
        <div className="panel-title" style={{ marginBottom: 9 }}>Devices</div>
        <StatusPill />
      </div>
      <div className="scroll-y" style={{ flex: 1, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {S.devices.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--text-dim)", fontSize: 11.5, padding: "24px 8px", lineHeight: 1.6 }}>
            {S.scanning ? "Scanning serial ports…" : "No devices found.\nClick Scan to discover."}
          </div>
        )}
        {S.devices.map((d) => <DeviceCard key={d.uid} dev={d} />)}
      </div>
      <div style={{ padding: 10, borderTop: "1px solid var(--border-soft)", display: "flex", flexDirection: "column", gap: 7 }}>
        <button className="btn" style={{ justifyContent: "center" }} onClick={() => void TcapiStore.scan()} disabled={S.scanning}>
          <span className={"dot-led " + (S.scanning ? "busy" : "")} style={{ width: 7, height: 7 }}></span>
          {S.scanning ? "Scanning…" : "Scan"}
        </button>
        {!isConn ? (
          <button className="btn primary" style={{ justifyContent: "center" }}
            disabled={!sel || S.connStatus === "connecting"}
            onClick={() => void TcapiStore.connect(sel)}>
            {S.connStatus === "connecting" ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <>
            <button className="btn danger" style={{ justifyContent: "center" }} onClick={() => void TcapiStore.disconnect()}>Disconnect</button>
            {hasReset && !showReset && (
              <button className="btn" style={{ justifyContent: "center", fontSize: 11.5 }} onClick={() => setShowReset(true)}>Reset…</button>
            )}
            {hasReset && showReset && <ResetMenu onClose={() => setShowReset(false)} />}
          </>
        )}
      </div>
    </div>
  );
}
