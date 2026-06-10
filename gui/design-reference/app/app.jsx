// ============================================================
// app.jsx — Pochi Tools GUI shell + assembly
// ============================================================
const { useState, useEffect, useRef } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#7c3aed",
  "layout": "scope",
  "density": "comfortable",
  "pinLayout": "grid",
  "pinShape": "circle",
  "waveformStyle": "scope"
}/*EDITMODE-END*/;

const DENSITY = {
  compact:     { pad: '9px',  gap: '7px',  row: '26px', fs: '12.5px' },
  comfortable: { pad: '14px', gap: '10px', row: '30px', fs: '13px' },
};
const LAYOUT_GPIO = { monitor: 0.52, split: 0.42, scope: 0.30 };

// ---------- resizer ----------
function Resizer({ dir, onDelta }) {
  const down = (e) => {
    e.preventDefault();
    const start = dir === 'x' ? e.clientX : e.clientY;
    let last = start;
    const move = (ev) => { const c = dir === 'x' ? ev.clientX : ev.clientY; onDelta(c - last); last = c; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    document.body.style.cursor = dir === 'x' ? 'col-resize' : 'row-resize';
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const isX = dir === 'x';
  return (
    <div onPointerDown={down} style={{
      flex: 'none', [isX ? 'width' : 'height']: 6, cursor: isX ? 'col-resize' : 'row-resize',
      background: 'var(--bg)', position: 'relative', zIndex: 5,
    }}>
      <div style={{ position: 'absolute', inset: isX ? '0 2px' : '2px 0', background: 'var(--border-soft)' }}></div>
    </div>
  );
}

// ---------- menu bar ----------
function MenuBar() {
  useStore(['conn']);
  const S = PochiStore.get();
  const menus = ['File', 'View', 'Device', 'Tools', 'Help'];
  const [open, setOpen] = useState(null);
  const connected = S.connStatus === 'connected';
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 38, background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '0 10px', gap: 4, flex: 'none', WebkitAppRegion: 'drag' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 12 }}>
        <Logo />
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '.01em' }}>Pochi Tools</span>
      </div>
      <div style={{ display: 'flex', gap: 1 }}>
        {menus.map((m) => (
          <button key={m} onMouseEnter={() => open !== null && setOpen(m)} onClick={() => setOpen(open === m ? null : m)}
            style={{ background: open === m ? 'var(--surface-hover)' : 'transparent', border: 0, color: 'var(--text-secondary)', fontSize: 12.5, padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
            {m}
          </button>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginRight: 10, padding: '3px 10px', borderRadius: 20, background: 'var(--surface-2)', border: '1px solid var(--border-soft)' }}>
        <span className={'dot-led ' + (connected ? 'on' : S.connStatus === 'connecting' ? 'busy' : 'low')}></span>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>{connected ? S.devices.find((d) => d.uid === S.connectedUid)?.port.replace('/dev/', '') : 'no link'}</span>
      </div>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
        {['#fbbf24', '#22c55e', '#ef4444'].map((c, i) => (
          <span key={i} style={{ width: 11, height: 11, borderRadius: '50%', background: c, opacity: .85 }}></span>
        ))}
      </div>
      {open && <div onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, zIndex: 1 }}></div>}
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
  useStore(['conn', 'pattern']);
  const [tab, setTab] = useState('output');
  const tabs = [
    ['output', 'Output', window.OutputControl],
    ['map', 'Pin Map', window.PinMapEditor],
    ['pattern', 'Pattern', window.PatternEditor],
    ['ts', 'Timestamp', window.TimestampViewer],
  ];
  const Active = tabs.find((t) => t[0] === tab)[2];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--surface)' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-soft)', flex: 'none' }}>
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            flex: 1, padding: '9px 4px', background: tab === id ? 'var(--surface)' : 'var(--surface-2)',
            border: 0, borderBottom: '2px solid ' + (tab === id ? 'var(--accent)' : 'transparent'),
            color: tab === id ? 'var(--text)' : 'var(--text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
            fontFamily: 'var(--font-sans)', letterSpacing: '.01em',
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
function StatusBar({ fps }) {
  useStore(['conn', 'pins', 'sim']);
  const S = PochiStore.get();
  const connected = S.connStatus === 'connected';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, height: 24, flex: 'none', background: 'var(--surface)', borderTop: '1px solid var(--border)', fontSize: 10.5, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
      <SbItem accent>{connected ? '● ' + (S.version ? 'fw ' + S.version.fw : '') : '○ offline'}</SbItem>
      <SbItem>map {S.splitIndex}o/{window.SIM.NUM_PINS - S.splitIndex}i</SbItem>
      <SbItem>sub {S.subscribed ? 'ON' : 'off'}</SbItem>
      <SbItem>t {(S.simT / 1000).toFixed(1)}ms</SbItem>
      <SbItem>scope {S.monitored.size}ch</SbItem>
      <div style={{ flex: 1 }} />
      <SbItem>{fps} fps</SbItem>
      <SbItem>125 MHz</SbItem>
      <SbItem accent>Pochi-DIO SDK 0.1.0</SbItem>
    </div>
  );
}
function SbItem({ children, accent }) {
  return <span style={{ padding: '0 11px', borderRight: '1px solid var(--border-soft)', color: accent ? 'var(--accent)' : 'inherit', display: 'flex', alignItems: 'center', height: '100%' }}>{children}</span>;
}

// ---------- app ----------
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [leftW, setLeftW] = useState(212);
  const [rightW, setRightW] = useState(264);
  const [logH, setLogH] = useState(156);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [gpioPct, setGpioPct] = useState(LAYOUT_GPIO[t.layout] ?? 0.4);
  const [fps, setFps] = useState(60);
  const centerRef = useRef(null);

  useEffect(() => { setGpioPct(LAYOUT_GPIO[t.layout] ?? 0.4); }, [t.layout]);

  // boot: start sim, scan, auto-connect for a live demo
  useEffect(() => {
    PochiStore.startLoop();
    PochiStore.scan();
    const id = setTimeout(() => {
      const S = PochiStore.get();
      if (S.devices[0]) PochiStore.connect(S.devices[0].uid);
    }, 1150);
    return () => clearTimeout(id);
  }, []);

  // fps meter
  useEffect(() => {
    let frames = 0, last = performance.now(), raf;
    const loop = (now) => { frames++; if (now - last >= 500) { setFps(Math.round(frames / ((now - last) / 1000))); frames = 0; last = now; } raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const d = DENSITY[t.density] || DENSITY.comfortable;
  const rootStyle = {
    height: '100%', display: 'flex', flexDirection: 'column',
    background: 'var(--bg)',
    '--accent': t.accent,
    '--accent-hover': `color-mix(in oklab, ${t.accent} 78%, #000)`,
    '--pad': d.pad, '--gap': d.gap, '--row-h': d.row,
    fontSize: d.fs,
  };

  return (
    <div style={rootStyle}>
      <MenuBar />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* left */}
        <div style={{ width: leftW, flex: 'none', background: 'var(--surface)', borderRight: '0', minWidth: 0 }}>
          <DevicePanel />
        </div>
        <Resizer dir="x" onDelta={(dx) => setLeftW((w) => Math.max(170, Math.min(320, w + dx)))} />
        {/* center */}
        <div ref={centerRef} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
          <div style={{ flex: gpioPct, minHeight: 70, background: 'var(--surface)', display: 'flex' }}>
            <GpioMonitor tweaks={t} />
          </div>
          <Resizer dir="y" onDelta={(dy) => {
            const h = centerRef.current?.clientHeight || 600;
            setGpioPct((p) => Math.max(0.12, Math.min(0.8, p + dy / h)));
          }} />
          <div style={{ flex: 1 - gpioPct, minHeight: 90, background: 'var(--surface)', display: 'flex' }}>
            <WaveformViewer tweaks={t} />
          </div>
        </div>
        <Resizer dir="x" onDelta={(dx) => setRightW((w) => Math.max(210, Math.min(380, w - dx)))} />
        {/* right */}
        <div style={{ width: rightW, flex: 'none', minWidth: 0 }}>
          <RightDock />
        </div>
      </div>
      {/* bottom log */}
      {!logCollapsed && <Resizer dir="y" onDelta={(dy) => setLogH((h) => Math.max(90, Math.min(360, h - dy)))} />}
      <div style={{ height: logCollapsed ? 34 : logH, flex: 'none', borderTop: '1px solid var(--border)' }}>
        <CommandLog collapsed={logCollapsed} onToggle={() => setLogCollapsed((c) => !c)} />
      </div>
      <StatusBar fps={fps} />

      {/* Tweaks */}
      <TweaksPanel>
        <TweakSection label="Layout" />
        <TweakRadio label="Center balance" value={t.layout} options={['monitor', 'split', 'scope']} onChange={(v) => setTweak('layout', v)} />
        <TweakRadio label="Density" value={t.density} options={['compact', 'comfortable']} onChange={(v) => setTweak('density', v)} />
        <TweakSection label="GPIO Monitor" />
        <TweakRadio label="Pin arrangement" value={t.pinLayout} options={['row', 'rows2', 'grid']} onChange={(v) => setTweak('pinLayout', v)} />
        <TweakRadio label="Pin shape" value={t.pinShape} options={['circle', 'square', 'led']} onChange={(v) => setTweak('pinShape', v)} />
        <TweakSection label="Waveform" />
        <TweakRadio label="Trace style" value={t.waveformStyle} options={['scope', 'minimal', 'filled']} onChange={(v) => setTweak('waveformStyle', v)} />
        <TweakSection label="Theme" />
        <TweakColor label="Accent" value={t.accent} options={['#7c3aed', '#0ea5e9', '#3b82f6', '#ec4899', '#14b8a6']} onChange={(v) => setTweak('accent', v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
