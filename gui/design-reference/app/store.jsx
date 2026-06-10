// ============================================================
// store.jsx — Pochi device simulation + global store
// Exposes to window: PochiStore, useStore, fmt, SIM
// ============================================================
(function () {
  const NUM_PINS = 23;

  // ---- deterministic signal helpers ----
  function hash(n) {
    n = (n ^ 61) ^ (n >>> 16);
    n = (n + (n << 3)) | 0;
    n = n ^ (n >>> 4);
    n = Math.imul(n, 0x27d4eb2d);
    n = n ^ (n >>> 15);
    return n >>> 0;
  }

  // input signal generators (assigned to input pins in order)
  const GEN_PRESETS = [
    { type: 'clk',  period: 1000, duty: 0.5, name: 'CLK 1.0k' },
    { type: 'clk',  period: 500,  duty: 0.5, name: 'CLK 2.0k' },
    { type: 'prbs', period: 320,  seed: 7,   name: 'DATA' },
    { type: 'clk',  period: 2000, duty: 0.25,name: 'PWM 25%' },
    { type: 'pulse',period: 1500, width: 120,name: 'STROBE' },
    { type: 'prbs', period: 600,  seed: 19,  name: 'DATA' },
    { type: 'clk',  period: 770,  duty: 0.5, name: 'CLK 1.3k' },
    { type: 'burst',period: 4000, on: 1300, sub: 180, name: 'BURST' },
    { type: 'const',v: 1, name: 'PULL-UP' },
    { type: 'clk',  period: 1300, duty: 0.5, name: 'CLK 770' },
    { type: 'prbs', period: 450,  seed: 33,  name: 'DATA' },
    { type: 'pulse',period: 2600, width: 90, name: 'TRIG' },
    { type: 'const',v: 0, name: 'GND' },
    { type: 'clk',  period: 3000, duty: 0.5, name: 'CLK 333' },
    { type: 'prbs', period: 900,  seed: 51,  name: 'DATA' },
  ];

  function genValue(gen, t) {
    if (!gen) return 0;
    switch (gen.type) {
      case 'clk':   return (t % gen.period) < gen.period * gen.duty ? 1 : 0;
      case 'pulse': return (t % gen.period) < gen.width ? 1 : 0;
      case 'prbs':  return hash(Math.floor(t / gen.period) + gen.seed) & 1;
      case 'burst': {
        const ph = t % gen.period;
        if (ph > gen.on) return 0;
        return (ph % gen.sub) < gen.sub * 0.5 ? 1 : 0;
      }
      case 'const': return gen.v;
      default: return 0;
    }
  }

  // ---- formatting ----
  const fmt = {
    hex: (v, w = 6) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0'),
    us: (t) => {
      if (Math.abs(t) >= 1000) return (t / 1000).toFixed(3) + ' ms';
      return Math.round(t) + ' µs';
    },
    ns: (t) => Math.round(t).toLocaleString() + ' ns',
    time: (d) => {
      const p = (n, l = 2) => String(n).padStart(l, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    },
  };

  // ---- store ----
  function createStore() {
    const versions = { conn: 0, pins: 0, log: 0, pattern: 0, ts: 0, map: 0, sim: 0, ui: 0 };
    const subs = new Set();
    function bump(...keys) {
      keys.forEach((k) => { versions[k] = (versions[k] + 1) % 1e9; });
      subs.forEach((fn) => fn());
    }
    function snap(keys) { return keys.map((k) => k + versions[k]).join('|'); }

    // initial pin meta
    const SPLIT = 8; // GP0..7 outputs, GP8..22 inputs
    const pinMeta = [];
    for (let i = 0; i < NUM_PINS; i++) {
      pinMeta.push({ gp: i, value: 0, lastChangeMs: null, pull: 'none', edges: 0 });
    }

    const demoPattern = [
      { out: 0b00000001, hold: 200 },
      { out: 0b00000011, hold: 200 },
      { out: 0b00000110, hold: 200 },
      { out: 0b00001100, hold: 200 },
      { out: 0b00011000, hold: 200 },
      { out: 0b00110000, hold: 200 },
      { out: 0b01100000, hold: 200 },
      { out: 0b11000000, hold: 200 },
      { out: 0b10000001, hold: 400 },
    ];

    const S = {
      // connection
      connStatus: 'disconnected',  // disconnected|connecting|connected|error
      scanning: false,
      devices: [],
      selectedUid: null,
      connectedUid: null,
      version: null,
      capabilities: null,
      subscribed: true,

      // pins
      splitIndex: SPLIT,
      pinMeta,
      outputs: 0,           // bitmask over output channel index
      pullDefault: 'down',

      // waveform
      monitored: new Set(),         // set of gp numbers shown in scope
      cursors: [{ t: 1500 }, { t: 3600 }],
      recording: true,
      windowUs: 6000,
      followLive: true,

      // pattern
      pattern: { steps: demoPattern, accepted: null, mode: 'loop', repeat: 0,
                 playState: 'idle', curStep: 0, loops: 0, _t0: 0 },

      // timestamp
      ts: { armed: false, mask: 0, edge: 'rising', result: null, _acc: [] },

      // log
      log: [],
      maxLog: 800,

      // sim
      simT: 0,
      _running: false,
      _lastReal: 0,
      _logThrottle: 0,
    };

    const SIM_US_PER_SEC = 6000;  // sim time advance per real second

    function gpDir(gp) {
      if (gp < S.splitIndex) return 'output';
      return 'input';
    }
    function outChannelOfGp(gp) { return gp; } // output channel index == gp for gp<split
    function inputGenForGp(gp) {
      const idx = gp - S.splitIndex;
      return GEN_PRESETS[idx % GEN_PRESETS.length];
    }
    // current logical value of a pin at sim time t
    function pinValueAt(gp, t) {
      if (gpDir(gp) === 'output') {
        return (S.outputs >> outChannelOfGp(gp)) & 1;
      }
      return genValue(inputGenForGp(gp), t);
    }

    function log(direction, text) {
      S.log.push({ id: Math.random().toString(36).slice(2), ts: new Date(), direction, text });
      if (S.log.length > S.maxLog) S.log.splice(0, S.log.length - S.maxLog);
      bump('log');
    }

    // ---- simulation tick ----
    function tick(now) {
      if (!S._running) return;
      const dtReal = Math.min(0.05, (now - S._lastReal) / 1000); // seconds, clamp
      S._lastReal = now;

      if (S.connStatus === 'connected') {
        S.simT += dtReal * SIM_US_PER_SEC;

        // advance pattern
        if (S.pattern.playState === 'running') advancePattern();

        // edge detection on all pins
        let anyEdge = false;
        const t = S.simT;
        for (let gp = 0; gp < NUM_PINS; gp++) {
          const v = pinValueAt(gp, t);
          const m = S.pinMeta[gp];
          if (v !== m.value) {
            m.value = v; m.lastChangeMs = t; m.edges++;
            anyEdge = true;
            // timestamp capture
            if (S.ts.armed && gpDir(gp) === 'input' && ((S.ts.mask >> gp) & 1)) {
              const rising = v === 1;
              if (S.ts.edge === 'both' || (S.ts.edge === 'rising') === rising) {
                if (S.ts._acc.length < 4096) {
                  S.ts._acc.push({ gp, t, value: v, inputs: inputsSnapshot(t) });
                }
              }
            }
          }
        }
        if (anyEdge) {
          bump('pins');
          // throttle push-event logging
          S._logThrottle++;
          if (S.subscribed && S._logThrottle % 9 === 0) {
            log('event', `! INPUT ${fmt.hex(inputsSnapshot(t))} t=${Math.round(t)}`);
          }
        }
        bump('sim');
      }
      requestAnimationFrame(tick);
    }
    function inputsSnapshot(t) {
      let v = 0;
      for (let gp = 0; gp < NUM_PINS; gp++) {
        if (gpDir(gp) === 'input' && pinValueAt(gp, t)) v |= (1 << gp);
      }
      return v >>> 0;
    }
    function outputsSnapshot() {
      let v = 0;
      for (let gp = 0; gp < NUM_PINS; gp++) {
        if (gpDir(gp) === 'output' && ((S.outputs >> gp) & 1)) v |= (1 << gp);
      }
      return v >>> 0;
    }

    function advancePattern() {
      const p = S.pattern;
      const elapsed = S.simT - p._t0;
      let acc = 0, idx = 0;
      const steps = p.steps;
      const totalHold = steps.reduce((a, s) => a + s.hold, 0);
      let pos = elapsed;
      if (p.mode === 'loop') {
        const loopsDone = Math.floor(pos / totalHold);
        if (p.repeat > 0 && loopsDone >= p.repeat) {
          finishPattern(); return;
        }
        p.loops = loopsDone;
        pos = pos % totalHold;
      } else {
        if (pos >= totalHold) { finishPattern(); return; }
      }
      for (let i = 0; i < steps.length; i++) {
        if (pos < acc + steps[i].hold) { idx = i; break; }
        acc += steps[i].hold;
      }
      if (idx !== p.curStep) { p.curStep = idx; bump('pattern'); }
      // drive outputs from step (only over output channels)
      S.outputs = steps[idx].out >>> 0;
    }
    function finishPattern() {
      S.pattern.playState = 'done';
      S.outputs = 0;
      log('received', '< OK PATTERN DONE');
      bump('pattern', 'pins');
    }

    // ====== ACTIONS ======
    const actions = {
      versions, snap, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      get: () => S, bump,
      // derived helpers exposed
      gpDir, pinValueAt, inputsSnapshot, outputsSnapshot, inputGenForGp, genValue,

      startLoop() {
        if (S._running) return;
        S._running = true;
        S._lastReal = performance.now();
        requestAnimationFrame(tick);
      },

      scan() {
        S.scanning = true; bump('conn');
        log('sent', '> discover');
        setTimeout(() => {
          S.devices = [
            { uid: 'E66038B713A4262F', num: 1, port: '/dev/ttyACM0', fw: '0.4.2' },
            { uid: 'E66038B7134C8331', num: 2, port: '/dev/ttyACM1', fw: '0.4.2' },
          ];
          S.scanning = false;
          if (!S.selectedUid) S.selectedUid = S.devices[0].uid;
          log('received', `< OK 2 devices`);
          bump('conn');
        }, 850);
      },
      select(uid) { S.selectedUid = uid; bump('conn'); },
      connect(uid) {
        const dev = S.devices.find((d) => d.uid === uid) || S.devices[0];
        if (!dev) return;
        S.selectedUid = dev.uid;
        S.connStatus = 'connecting'; bump('conn');
        log('sent', `> connect ${dev.port}`);
        setTimeout(() => {
          S.connStatus = 'connected';
          S.connectedUid = dev.uid;
          S.version = { fw: dev.fw, proto: '1.2', build: '2026-05-18' };
          S.capabilities = { pins: 23, maxPattern: 256, tsDepth: 4096, clockMhz: 125, sync: true };
          // default monitor first 8 inputs
          S.monitored = new Set();
          for (let gp = S.splitIndex; gp < NUM_PINS && S.monitored.size < 8; gp++) S.monitored.add(gp);
          log('received', `< OK CONNECT uid=${dev.uid} fw=${dev.fw}`);
          log('received', `< OK CAPS pins=23 pat=256 ts=4096`);
          bump('conn', 'pins', 'map');
        }, 900);
      },
      disconnect() {
        log('sent', '> disconnect');
        S.connStatus = 'disconnected';
        S.connectedUid = null; S.version = null; S.capabilities = null;
        S.pattern.playState = 'idle'; S.outputs = 0;
        S.ts.armed = false; S.ts.result = null; S.ts._acc = [];
        log('received', '< OK');
        bump('conn', 'pins', 'pattern', 'ts');
      },

      readState() {
        if (S.connStatus !== 'connected') return;
        const inp = inputsSnapshot(S.simT);
        log('sent', '> read');
        log('received', `< OK ${fmt.hex(inp)}`);
        bump('log');
      },
      setSubscribe(on) {
        S.subscribed = on;
        log('sent', `> subscribe ${on ? 'on' : 'off'}`);
        log('received', '< OK');
        bump('conn');
      },

      // outputs
      toggleOutput(gp) {
        if (S.pattern.playState === 'running') return;
        const bit = 1 << gp;
        const newVal = (S.outputs ^ bit) >>> 0;
        S.outputs = newVal;
        log('sent', `> write ${fmt.hex(outputsSnapshot())} ${fmt.hex(outputMask())}`);
        log('received', '< OK');
        bump('pins', 'log');
      },
      setAllOutputs(v) {
        if (S.pattern.playState === 'running') return;
        let mask = 0;
        for (let gp = 0; gp < S.splitIndex; gp++) mask |= (1 << gp);
        S.outputs = v ? mask : 0;
        log('sent', `> write ${fmt.hex(outputsSnapshot())} ${fmt.hex(mask)}`);
        log('received', '< OK');
        bump('pins', 'log');
      },
      invertOutputs() {
        if (S.pattern.playState === 'running') return;
        let mask = 0;
        for (let gp = 0; gp < S.splitIndex; gp++) mask |= (1 << gp);
        S.outputs = (~S.outputs & mask) >>> 0;
        log('sent', `> write ${fmt.hex(S.outputs)} ${fmt.hex(mask)}`);
        log('received', '< OK');
        bump('pins', 'log');
      },
      writeHex(v) {
        if (S.pattern.playState === 'running') return;
        let mask = 0;
        for (let gp = 0; gp < S.splitIndex; gp++) mask |= (1 << gp);
        S.outputs = (v & mask) >>> 0;
        log('sent', `> write ${fmt.hex(S.outputs)} ${fmt.hex(mask)}`);
        log('received', '< OK');
        bump('pins', 'log');
      },

      // pin map
      setSplit(idx) {
        idx = Math.max(0, Math.min(NUM_PINS, idx));
        S.splitIndex = idx;
        // re-clamp outputs & monitored
        let mask = 0; for (let gp = 0; gp < idx; gp++) mask |= (1 << gp);
        S.outputs = (S.outputs & mask) >>> 0;
        bump('map', 'pins');
      },
      setPull(mode) { S.pullDefault = mode; bump('map'); },
      applyMap() {
        log('sent', `> map set split=${S.splitIndex} pull=${S.pullDefault}`);
        log('received', '< OK');
        S._mapApplied = true; bump('map', 'log');
      },
      saveMap() {
        log('sent', '> map save');
        log('received', '< OK FLASH WRITTEN');
        bump('log');
      },
      defaultMap() {
        S.splitIndex = SPLIT; S.pullDefault = 'down';
        log('sent', '> map default');
        log('received', '< OK');
        bump('map', 'pins', 'log');
      },

      // waveform
      toggleMonitor(gp) {
        if (S.monitored.has(gp)) S.monitored.delete(gp); else S.monitored.add(gp);
        bump('map');
      },
      setCursor(i, t) { S.cursors[i].t = t; bump('sim'); },
      clearWave() { log('sent', '> clear'); bump('sim'); },
      setRecording(on) { S.recording = on; bump('sim'); },
      setWindow(us) { S.windowUs = us; bump('sim'); },

      // pattern
      loadPattern(steps) {
        S.pattern.steps = steps;
        S.pattern.accepted = Math.min(steps.length, 256);
        S.pattern.playState = 'idle'; S.pattern.curStep = 0; S.pattern.loops = 0;
        log('sent', `> pattern load (${steps.length} steps)`);
        log('received', `< OK ACCEPTED ${S.pattern.accepted}`);
        bump('pattern', 'log');
      },
      addStep() {
        S.pattern.steps.push({ out: 0, hold: 200 });
        S.pattern.accepted = null; bump('pattern');
      },
      removeStep(i) { S.pattern.steps.splice(i, 1); S.pattern.accepted = null; bump('pattern'); },
      updateStep(i, patch) { Object.assign(S.pattern.steps[i], patch); S.pattern.accepted = null; bump('pattern'); },
      setPatternMode(m) { S.pattern.mode = m; bump('pattern'); },
      setPatternRepeat(n) { S.pattern.repeat = n; bump('pattern'); },
      runPattern() {
        if (S.connStatus !== 'connected' || !S.pattern.steps.length) return;
        if (S.pattern.accepted == null) actions.loadPattern(S.pattern.steps);
        S.pattern.playState = 'running'; S.pattern._t0 = S.simT;
        S.pattern.curStep = 0; S.pattern.loops = 0;
        // ensure output pins are on scope
        for (let gp = 0; gp < S.splitIndex; gp++) S.monitored.add(gp);
        log('sent', `> pattern run ${S.pattern.mode}${S.pattern.mode === 'loop' ? ' x' + (S.pattern.repeat || '∞') : ''}`);
        log('received', '< OK RUNNING');
        bump('pattern', 'map');
      },
      stopPattern() {
        S.pattern.playState = 'idle'; S.outputs = 0;
        log('sent', '> pattern stop');
        log('received', '< OK');
        bump('pattern', 'pins');
      },

      // timestamp
      armTs(mask, edge) {
        S.ts.armed = true; S.ts.mask = mask; S.ts.edge = edge; S.ts._acc = []; S.ts.result = null;
        log('sent', `> ts arm mask=${fmt.hex(mask)} edge=${edge}`);
        log('received', '< OK ARMED');
        bump('ts', 'log');
      },
      disarmTs() { S.ts.armed = false; log('sent', '> ts disarm'); log('received', '< OK'); bump('ts'); },
      captureTs(reconcile) {
        const acc = S.ts._acc.slice(-512);
        const rows = acc.map((e, i) => {
          const rawCount = Math.round(e.t * 125);       // 125 MHz
          const rawPhase = hash(rawCount) % 8;
          let computedNs = e.t * 1000;
          let reconciled = false;
          if (reconcile && (hash(i + 3) % 5 === 0)) {
            computedNs += (rawPhase - 4) * 8;            // small adjustment
            reconciled = true;
          }
          return {
            idx: i, inputs: e.inputs, gp: e.gp, value: e.value,
            rawCount, rawPhase, syncActive: reconcile,
            computedNs, reconciled,
          };
        });
        S.ts.result = {
          rows, reconciled: reconcile,
          span: rows.length ? rows[rows.length - 1].computedNs - rows[0].computedNs : 0,
        };
        log('sent', `> ts get${reconcile ? ' --reconcile' : ''} max=512`);
        log('received', `< OK ${rows.length} EVENTS`);
        bump('ts', 'log');
      },

      // raw repl
      raw(text) {
        log('sent', '> ' + text);
        const t = text.trim().toLowerCase();
        let resp = '< OK';
        if (t === 'read') resp = `< OK ${fmt.hex(inputsSnapshot(S.simT))}`;
        else if (t.startsWith('version')) resp = `< OK fw=${S.version?.fw || '-'} proto=1.2`;
        else if (t.startsWith('caps')) resp = `< OK pins=23 pat=256 ts=4096`;
        else if (t === '') return;
        else if (t.startsWith('state')) resp = `< OK in=${fmt.hex(inputsSnapshot(S.simT))} out=${fmt.hex(outputsSnapshot())}`;
        log('received', resp);
        bump('log');
      },
      clearLog() { S.log = []; bump('log'); },
    };
    function outputMask() { let m = 0; for (let gp = 0; gp < S.splitIndex; gp++) m |= (1 << gp); return m >>> 0; }

    return actions;
  }

  const PochiStore = createStore();

  // React hook: re-render when any of the named version keys change
  function useStore(keys) {
    const k = Array.isArray(keys) ? keys : [keys];
    const React = window.React;
    return React.useSyncExternalStore(
      PochiStore.subscribe,
      () => PochiStore.snap(k),
    );
  }

  window.PochiStore = PochiStore;
  window.useStore = useStore;
  window.fmt = fmt;
  window.SIM = { NUM_PINS, GEN_PRESETS, genValue };
})();
