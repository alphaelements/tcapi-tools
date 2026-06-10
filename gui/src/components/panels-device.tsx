// ============================================================
// panels-device.tsx — DevicePanel (left sidebar)
// Ported from design-reference panels-device.jsx (mechanical
// ESM/TSX conversion; structure and inline styles unchanged).
// ============================================================
import { DeviceEntry, PochiStore, useStore } from "../store/store";

function StatusPill() {
  useStore(["conn"]);
  const S = PochiStore.get();
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
  const S = PochiStore.get();
  const selected = S.selectedUid === dev.uid;
  const connected = S.connectedUid === dev.uid;
  return (
    <div
      onClick={() => PochiStore.select(dev.uid)}
      onDoubleClick={() => void PochiStore.connect(dev.uid)}
      style={{
        padding: "10px 11px", borderRadius: "var(--r-md)", cursor: "pointer",
        background: selected ? "var(--surface-hover)" : "var(--surface-2)",
        border: "1px solid " + (connected ? "var(--high)" : selected ? "color-mix(in oklab, var(--accent) 55%, var(--border))" : "var(--border-soft)"),
        boxShadow: connected ? "0 0 0 1px color-mix(in oklab, var(--high) 30%, transparent), 0 0 16px -6px var(--high-glow)" : "none",
        transition: "background .12s, border-color .12s",
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className={"dot-led " + (connected ? "on" : "low")}></span>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>Pochi-DIO #{dev.num ?? "?"}</span>
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
          <Info k="clock" v={S.capabilities?.clockMhz + "MHz"} />
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

export function DevicePanel() {
  useStore(["conn"]);
  const S = PochiStore.get();
  const isConn = S.connStatus === "connected";
  const sel = S.selectedUid;
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
        <button className="btn" style={{ justifyContent: "center" }} onClick={() => void PochiStore.scan()} disabled={S.scanning}>
          <span className={"dot-led " + (S.scanning ? "busy" : "")} style={{ width: 7, height: 7 }}></span>
          {S.scanning ? "Scanning…" : "Scan"}
        </button>
        {!isConn ? (
          <button className="btn primary" style={{ justifyContent: "center" }}
            disabled={!sel || S.connStatus === "connecting"}
            onClick={() => void PochiStore.connect(sel)}>
            {S.connStatus === "connecting" ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <button className="btn danger" style={{ justifyContent: "center" }} onClick={() => void PochiStore.disconnect()}>Disconnect</button>
        )}
      </div>
    </div>
  );
}
