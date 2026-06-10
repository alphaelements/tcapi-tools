// ============================================================
// panels-output-map.jsx — OutputControl + PinMapEditor
// Exports: window.OutputControl, window.PinMapEditor
// ============================================================
(function () {
  const { useState, useRef } = React;

  // ---------------- OutputControl ----------------
  function OutputControl() {
    useStore(['pins', 'map', 'conn', 'pattern']);
    const S = PochiStore.get();
    const connected = S.connStatus === 'connected';
    const locked = S.pattern.playState === 'running';
    const outs = [];
    for (let gp = 0; gp < S.splitIndex; gp++) outs.push(gp);
    const [hex, setHex] = useState('');

    const disabled = !connected || outs.length === 0 || locked;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {locked && (
          <div className="mono" style={{ fontSize: 10.5, color: '#fbbf24', background: 'color-mix(in oklab,#fbbf24 12%, var(--surface-2))', border: '1px solid color-mix(in oklab,#fbbf24 30%, var(--border))', borderRadius: 'var(--r-sm)', padding: '5px 8px' }}>
            ⏵ Pattern driving outputs — controls locked
          </div>
        )}
        {outs.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', padding: '10px 4px', lineHeight: 1.5 }}>No output pins configured. Set a split point in the Pin Map.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {outs.map((gp) => {
            const on = (S.outputs >> gp) & 1;
            return (
              <div key={gp} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 9px', borderRadius: 'var(--r-sm)', background: on ? 'color-mix(in oklab, var(--high) 8%, var(--surface-2))' : 'var(--surface-2)', border: '1px solid ' + (on ? 'color-mix(in oklab,var(--high) 26%, var(--border-soft))' : 'var(--border-soft)') }}>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600, width: 40 }}>GP{String(gp).padStart(2, '0')}</span>
                <span className={'dot-led ' + (on ? 'on' : 'low')}></span>
                <span className="mono" style={{ fontSize: 10.5, color: on ? 'var(--high)' : 'var(--text-dim)', width: 34 }}>{on ? 'HIGH' : 'LOW'}</span>
                <div style={{ flex: 1 }} />
                <span className={'switch ' + (on ? 'on' : '')} onClick={() => !disabled && PochiStore.toggleOutput(gp)} style={{ opacity: disabled ? 0.4 : 1, pointerEvents: disabled ? 'none' : 'auto' }}></span>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm" style={{ flex: 1, justifyContent: 'center' }} disabled={disabled} onClick={() => PochiStore.setAllOutputs(true)}>All HIGH</button>
          <button className="btn sm" style={{ flex: 1, justifyContent: 'center' }} disabled={disabled} onClick={() => PochiStore.setAllOutputs(false)}>All LOW</button>
          <button className="btn sm" style={{ flex: 1, justifyContent: 'center' }} disabled={disabled} onClick={() => PochiStore.invertOutputs()}>Invert</button>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="eyebrow">write</span>
          <input className="field" placeholder="0x00" value={hex} disabled={disabled}
            onChange={(e) => setHex(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { const v = parseInt(hex, 16); if (!isNaN(v)) PochiStore.writeHex(v); } }}
            style={{ flex: 1, minWidth: 0 }} />
          <button className="btn sm primary" disabled={disabled} onClick={() => { const v = parseInt(hex, 16); if (!isNaN(v)) PochiStore.writeHex(v); }}>Set</button>
        </div>
      </div>
    );
  }

  // ---------------- PinMapEditor ----------------
  function PinMapEditor() {
    useStore(['map', 'conn']);
    const S = PochiStore.get();
    const connected = S.connStatus === 'connected';
    const stripRef = useRef(null);
    const N = window.SIM.NUM_PINS;
    const dirty = S._mapApplied === false;

    function onBoundaryDrag(e) {
      e.preventDefault();
      const move = (ev) => {
        const rect = stripRef.current.getBoundingClientRect();
        const x = (ev.clientX ?? ev.touches?.[0]?.clientX) - rect.left;
        const idx = Math.round((x / rect.width) * N);
        PochiStore.setSplit(idx);
        S._mapApplied = false;
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    }

    const cellW = `calc((100% - ${(N - 1) * 3}px) / ${N})`;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: connected ? 1 : 0.5, pointerEvents: connected ? 'auto' : 'none' }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="eyebrow">GP0 — GP{N - 1}</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{S.splitIndex} out / {N - S.splitIndex} in</span>
          </div>
          {/* strip */}
          <div ref={stripRef} style={{ position: 'relative', display: 'flex', gap: 3, padding: '2px 0' }}>
            {Array.from({ length: N }).map((_, gp) => {
              const isOut = gp < S.splitIndex;
              return (
                <div key={gp} style={{ width: cellW, height: 34, borderRadius: 3, background: isOut ? 'color-mix(in oklab, var(--accent) 30%, var(--surface-2))' : 'color-mix(in oklab, #38bdf8 18%, var(--surface-2))', border: '1px solid ' + (isOut ? 'color-mix(in oklab, var(--accent) 50%, var(--border))' : 'color-mix(in oklab,#38bdf8 35%, var(--border))'), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span className="mono" style={{ fontSize: 8, color: 'var(--text-secondary)' }}>{gp}</span>
                </div>
              );
            })}
            {/* boundary handle */}
            <div onPointerDown={onBoundaryDrag} style={{ position: 'absolute', top: -3, bottom: -3, left: `calc(${(S.splitIndex / N) * 100}% - 6px)`, width: 12, cursor: 'ew-resize', display: 'flex', justifyContent: 'center', zIndex: 2 }}>
              <div style={{ width: 3, background: 'var(--warn)', borderRadius: 2, boxShadow: '0 0 8px color-mix(in oklab,var(--warn) 60%, transparent)' }}></div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            <span className="chip out">◀ OUTPUT {S.splitIndex}</span>
            <span className="chip in">INPUT {N - S.splitIndex} ▶</span>
          </div>
        </div>

        <Field label="Pull mode">
          <div className="seg" style={{ width: '100%' }}>
            {['up', 'down', 'none'].map((m) => (
              <button key={m} style={{ flex: 1 }} className={S.pullDefault === m ? 'active' : ''} onClick={() => { PochiStore.setPull(m); S._mapApplied = false; }}>{m}</button>
            ))}
          </div>
        </Field>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Check label="Timestamp capture enabled" defaultChecked />
          <Check label="Change-notify by default" defaultChecked />
          <Check label="Open-drain outputs" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <button className="btn primary sm" style={{ justifyContent: 'center' }} onClick={() => PochiStore.applyMap()}>Apply</button>
          <button className="btn sm" style={{ justifyContent: 'center' }} onClick={() => PochiStore.saveMap()}>Save to Flash</button>
          <button className="btn sm" style={{ justifyContent: 'center' }} onClick={() => PochiStore.defaultMap()}>Reset Default</button>
          <button className="btn sm" style={{ justifyContent: 'center' }} onClick={() => PochiStore.applyMap()}>Load TOML…</button>
        </div>
      </div>
    );
  }

  function Field({ label, children }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span className="eyebrow">{label}</span>
        {children}
      </div>
    );
  }
  function Check({ label, defaultChecked }) {
    const [on, setOn] = useState(!!defaultChecked);
    return (
      <label onClick={() => setOn(!on)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-secondary)', cursor: 'pointer' }}>
        <span style={{ width: 15, height: 15, borderRadius: 3, border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'), background: on ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          {on && <svg width="9" height="9" viewBox="0 0 12 12"><path d="M2 6l3 3 5-6" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </span>
        {label}
      </label>
    );
  }

  window.OutputControl = OutputControl;
  window.PinMapEditor = PinMapEditor;
})();
