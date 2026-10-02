# GUI Feature Specification

Design specification for the Pochi Tools GUI application. This document
provides complete context for implementing the desktop application.

## 1. Overview

Pochi Tools GUI is a desktop application for controlling and monitoring
Pochi-DIO devices. It provides real-time visualization of GPIO states,
waveform display, output control, pin map configuration, and pattern
editing -- all through a modern, dark-themed interface.

The application targets hardware engineers and embedded developers who
need to:

- Monitor digital I/O states in real time
- Generate and control output patterns
- Capture and analyze input timing with sub-microsecond precision
- Configure multi-device setups with synchronized clocks

## 2. Technology Stack

| Component | Technology | Version |
|---|---|---|
| Desktop framework | Tauri | v2 |
| Backend language | Rust | stable |
| Frontend framework | React | 19 |
| Frontend language | TypeScript | 5.6+ |
| Build tool | Vite | 6 |
| Charting | custom Canvas 2D renderer (from the design prototype) | -- |
| State management | version-key store + `useSyncExternalStore` (from the design prototype) | -- |
| Serial communication | pochi-sdk (Rust crate) | 0.1.0 |
| IPC | Tauri command/event system | -- |

### Why Tauri v2

- Native serial port access from Rust backend (no Electron serial bridge)
- Direct integration with `pochi-sdk` (Rust) -- no FFI overhead
- Small binary size (~10MB vs Electron's ~100MB+)
- Cross-platform: Linux, macOS, Windows from the same codebase
- Push events from device flow through Tauri's event system naturally

### Build Configuration

The application is configured in `gui/src-tauri/tauri.conf.json`:

- **Identifier**: `com.alphaelements.pochi-tools`
- **Window**: 1280x800, resizable, not fullscreen
- **Dev server**: Vite at `http://localhost:1420`

### Testing

- **Unit (frontend)**: vitest, `npm test` — scoped to `src/**/*.test.ts`:
  channel/GP helpers (`pins.ts`), the v2 map editor helpers (`pinmap.ts`),
  pattern tick conversion (`pattern.ts`), and the mock device conformance
  test (below).
- **Unit (backend)**: `cargo test -p pochi-gui` — event routing, reconcile
  rows, `ts get` draining, TOML loading through the SDK config parsers,
  state.
- **Mock device conformance (golden)**: the browser-only virtual device is
  `src/lib/mock-device-core.ts`, a v2 text-protocol model (`execute("map
  get")` returns the wire lines a firmware answers). `mock-device-golden
  .test.ts` replays every golden case of `protocol/golden/*.txt` whose
  requests and directives the model implements (map, io, pattern incl.
  timing, timestamp, events, errors, reset — a few hundred cases) and
  compares the emitted lines byte for byte. Cases that need multi-device
  `sync`, fault injection, binary framing or the pattern timeout are
  excluded with a stated reason; floors on the replayed count keep the
  filter from silently dropping the corpus. The mock must therefore be
  updated whenever the golden transcripts are revised.
- **E2E**: Playwright, `npm run test:e2e` — runs the full UI against the
  virtual device (`src/lib/mock-device.ts`, activated with `/?mock` on
  the dev server). `mock-device.ts` is the browser-side counterpart of the
  Rust backend: it turns each Tauri command into the wire line(s) the SDK
  sends (so the command log shows real v2 lines), parses the response, and
  forwards `! INPUT` / `! PATTERN_DONE` as `pochi://*` events. It mirrors
  the rig's loopback wiring (the k-th output pin drives the k-th input pin:
  GP0 → GP12 … GP11 → GP26) and boots with a saved map of GP0-GP11 as
  outputs. `window.__POCHI_MOCK__` offers test hooks (forced ts overflow,
  saved-file capture, direct edge injection). `sync *` is not modelled.
- **Hardware**: manual pass driven over Xvfb + xdotool (see
  `tmp/` handoffs); requires a connected Pochi-DIO.

## 3. Color Palette

The application uses a dark theme optimized for long hardware debugging
sessions and consistent with professional test equipment interfaces.

| Token | Hex | Usage |
|---|---|---|
| `bg` | `#1e1e2e` | Application background |
| `surface` | `#2a2a3e` | Panel backgrounds, cards |
| `surface-hover` | `#353550` | Hover states on surface elements |
| `accent` | `#7c3aed` | Primary action buttons, active tabs, selection |
| `accent-hover` | `#6d28d9` | Hover state for accent elements |
| `high` | `#22c55e` | Logic HIGH state, success indicators, connected |
| `low` | `#64748b` | Logic LOW state, inactive, disabled |
| `warn` | `#ef4444` | Error states, warnings, disconnected |
| `text` | `#e2e8f0` | Primary text |
| `text-secondary` | `#94a3b8` | Secondary text, labels, timestamps |
| `border` | `#374151` | Borders, dividers |

### GPIO Pin State Colors

| State | Color | Description |
|---|---|---|
| Input HIGH | `#22c55e` (high) | Bright green, immediately visible |
| Input LOW | `#64748b` (low) | Muted gray, recedes visually |
| Output HIGH | `#22c55e` (high) | Same green as input HIGH |
| Output LOW | `#64748b` (low) | Same gray as input LOW |
| Unassigned | `#374151` (border) | Very dim, clearly inactive |

## 4. Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Menu Bar                                          [_][□][X] │
├──────────┬───────────────────────────────┬───────────────────┤
│          │                               │                   │
│  Device  │    GPIO Monitor               │  Output Control   │
│  Panel   │    ┌─────────────────────┐    │                   │
│          │    │ GP0  GP1  GP2  ...  │    │  [GP0 ] [toggle]  │
│  ┌────┐  │    │  ●    ●    ○   ... │    │  [GP1 ] [toggle]  │
│  │ #1 │  │    │ OUT  OUT  IN   ... │    │  [GP2 ] [toggle]  │
│  │ACM0│  │    └─────────────────────┘    │  ...              │
│  └────┘  │                               │                   │
│  ┌────┐  │    Waveform Viewer            │  ─────────────    │
│  │ #2 │  │    ┌─────────────────────┐    │                   │
│  │ACM1│  │    │ ─┐ ┌─┐   ┌─────┐   │    │  Pattern Editor   │
│  └────┘  │    │  └─┘ └───┘     └── │    │  [Load] [Run]     │
│          │    │ ─────┐       ┌───── │    │  [Stop] [Status]  │
│  [Scan]  │    │      └───────┘      │    │                   │
│  [Conn]  │    └─────────────────────┘    │                   │
│          │                               │                   │
├──────────┴───────────────────────────────┴───────────────────┤
│  Command Log / Status Bar                                    │
└──────────────────────────────────────────────────────────────┘
```

### Panel Organization

- **Left sidebar** (200px, resizable): Device panel -- list of connected
  devices, connection controls, device info
- **Center area** (flexible): Split vertically into GPIO Monitor (top) and
  Waveform Viewer (bottom), with a draggable splitter
- **Right sidebar** (240px, resizable): Output Control, Pin Map Editor,
  and Pattern Editor (tabbed or stacked)
- **Bottom bar** (120px, collapsible): Command log showing all
  commands/responses, status information
- **Top menu bar**: File, View, Device, Tools, Help

## 5. Feature List by Priority

### P0 -- MVP (Minimum Viable Product)

The features needed for the first usable release.

| Feature | Component | Description |
|---|---|---|
| Device discovery | DevicePanel | Scan for connected devices, show list |
| Device connection | DevicePanel | Connect/disconnect, show status |
| GPIO state display | GpioMonitor | Show all 25 channels (ch0-ch24) with direction and state |
| Input reading | GpioMonitor | Poll and display current input values |
| Output control | OutputControl | Toggle individual output pins |
| Pin map display | PinMapEditor | Show current pin configuration |
| Command log | CommandLog | Show all serial commands and responses |
| Dark theme | Global | Apply the color palette consistently |

### P1 -- Core Functionality

| Feature | Component | Description |
|---|---|---|
| Real-time monitoring | GpioMonitor | Subscribe to input changes, live update |
| Waveform display | WaveformViewer | Plot input state over time (Canvas 2D) |
| Pin map editing | PinMapEditor | Visual editor for pin assignment |
| Pin map save/load | PinMapEditor | Save to device flash, load from TOML file |
| Pattern upload | PatternEditor | Load patterns from TOML, send to device |
| Pattern playback | PatternEditor | Run/stop/status controls |
| Device info display | DevicePanel | Show version, capabilities, UID |
| JSON export | Global | Export current state/timestamps as JSON |

### P2 -- Advanced Features

| Feature | Component | Description |
|---|---|---|
| Timestamp capture | TimestampViewer | Arm, capture, display with ns precision |
| Reconcile display | TimestampViewer | Show raw vs. reconciled timestamps |
| Multi-device view | DevicePanel | Manage multiple connected devices |
| Sync controls | SyncPanel | Master/slave setup, sync start/stop |
| Waveform zoom/pan | WaveformViewer | Time axis zoom, scroll, cursor readout |
| Waveform measurement | WaveformViewer | Delta-T cursors, frequency measurement |
| Pattern visual editor | PatternEditor | Drag-to-edit waveform pattern builder |
| Keyboard shortcuts | Global | Common operations accessible via keyboard |

### P3 -- Polish and Extras

| Feature | Component | Description |
|---|---|---|
| Cross-device waveform | WaveformViewer | Overlay waveforms from multiple devices |
| REPL console | CommandLog | Interactive command input (like CLI) |
| Settings persistence | Global | Remember window layout, last device, etc. |
| Export waveform | WaveformViewer | Export as CSV, PNG, or SVG |
| Firmware update | DevicePanel | Flash new firmware via BOOTSEL mode |
| Drag-and-drop TOML | PinMapEditor/PatternEditor | Drag map/pattern files onto panels |
| Notification system | Global | Toast notifications for events |

## 6. Component Specifications

### DevicePanel

**Purpose**: Discover, connect to, and display information about Pochi-DIO
devices.

**State**:
```typescript
interface DevicePanelState {
    devices: DeviceInfo[];
    selectedDeviceUid: string | null;
    connectionStatus: "disconnected" | "connecting" | "connected" | "error";
    scanning: boolean;
    errorMessage: string | null;
}
```

**Behavior**:
- On mount and on "Scan" button click: invoke `discover` Tauri command.
- Display each device as a card showing UID (truncated), device number,
  port path, and connection status indicator (green/red dot).
- Click a device card to select it. Double-click or "Connect" button to
  connect.
- Connected device card shows version and capabilities.
- "Disconnect" button closes the connection.
- Auto-scan on application launch (configurable).

**Tauri Commands**:
```rust
#[tauri::command]
fn discover() -> Result<Vec<DeviceInfo>, String>

#[tauri::command]
fn connect(port: String) -> Result<DeviceInfo, String>

#[tauri::command]
fn disconnect() -> Result<(), String>
```

### GpioMonitor

**Purpose**: Display real-time state of all 25 DIO channels (ch0-ch24; ch23 = GP26,
ch24 = GP27, see `protocol-reference.md` section 10).

**Visual Design**:
- Grid of 25 channel indicators arranged in a single row or 2 rows
  (configurable).
- Each pin shows: channel and GP label (`pin_label`), direction (IN/OUT/--), current state
  (filled circle = HIGH, empty circle = LOW).
- Color: HIGH = `#22c55e`, LOW = `#64748b`, unassigned = `#374151`.
- Tooltip on hover shows full pin info (GP number, direction, pull,
  current value, last change timestamp).

**State**:
```typescript
interface GpioMonitorState {
    pinStates: PinState[];
    pinMap: PinMap | null;
    lastUpdateTimestamp: number;
}

interface PinState {
    gpNumber: number;
    direction: "input" | "output" | "unassigned";
    value: boolean;
    lastChangeMs: number | null;
}
```

**Behavior**:
- On connection: fetch `state` and `map get` to initialize.
- When subscribed: update pin states in real time from push events.
- When not subscribed: poll `state` every 100ms (configurable).
- Animate state transitions (brief flash on change).

**Tauri Commands**:
```rust
#[tauri::command]
fn read_state() -> Result<IoState, String>

#[tauri::command]
fn map_get() -> Result<PinMap, String>

#[tauri::command]
fn subscribe(enable: bool) -> Result<(), String>
```

**Tauri Events** (backend to frontend):
```rust
// `inputs` is the logical input word, bit = GP pin
app.emit("pochi://input", json!({ "inputs": inputs, "timestampUs": t_us }));
```

### OutputControl

**Purpose**: Control individual output pins.

**Visual Design**:
- Vertical list of output pins (only those configured as output in the
  current pin map).
- Each row: GP label, toggle switch, current state indicator.
- "Set All High" / "Set All Low" / "Invert All" bulk action buttons.
- Hex value input field for direct bit pattern entry (a wire word: bit =
  GP pin; bits outside the outputs are ignored by the device).

**State**:
```typescript
interface OutputControlState {
    outputPins: OutputPin[];
    pendingWrite: boolean;
}

interface OutputPin {
    gpNumber: number;
    channelIndex: number;
    value: boolean;
}
```

**Behavior**:
- Toggle switch sends `write <values> <mask>` with only the changed bit.
- Bulk actions send `write` with full mask.
- Hex input parses and sends the complete output value.
- Disable controls when no output pins are configured.
- Show error inline if write fails (e.g., `ERR NO_RESOURCE`).

### PinMapEditor

**Purpose**: View and edit the GPIO pin map configuration.

**Visual Design**:
- Visual representation of ch0-ch24 (GP0-GP22, GP26, GP27) as a horizontal
  strip; each cell is coloured by the channel's `dir` bit and its tooltip
  names the pin (`pin_label`, e.g. `GP26 (ch23)`).
- A draggable boundary rewrites `dir` as "ch0..n-1 outputs, the rest
  inputs"; channels that change role get the map's current pull / notify
  setting and lose the masks that no longer apply (R-M1).
- Pull buttons (none/up/down) set `pu`/`pd` for every input; the active
  button is the shared setting, none is active when inputs differ (a loaded
  `map.toml` may set them per pin).
- "Change-notify on inputs" sets the `edge` mask (all inputs / none); it
  controls which inputs raise `! INPUT` events.
- `flags` is reserved and always 0; `def`, `opol` and `ipol` are preserved
  from the device or a loaded `map.toml` (they are not editable on the
  strip yet).
- "Apply" button sends `map set`, "Save to Flash" sends `map save`.
- "Reset to Default" sends `map default` (every pin an input, pull-down,
  edge events on).
- "Load TOML" opens a file dialog; the file is evaluated by the SDK config
  parser (`map_load_toml`, `docs/config-files.md`) and applied. Errors are
  shown in the command log as `<file>:<line>: <message>`.

**State**:
```typescript
interface PinMapEditorState {
    currentMap: PinMap | null;
    editingMap: PinMap | null;
    isDirty: boolean;
    saving: boolean;
}
```

**Behavior**:
- On connection: load current map from device.
- Editing creates a local copy; "Apply" sends to device.
- Visual feedback: green border on applied map, yellow on unsaved edits.
- A successful `map set` / `map default` returns the device's pattern
  engine to idle with its steps erased and disarms timestamp capture
  (R-M5); the GUI mirrors this (pattern "accepted" count cleared, ARMED
  off) and re-reads `state`, because the output latch restarts at `def`.

**Editable surface**:
The v2 map is per channel: it holds the eight map values `flags`
(reserved, always 0), `dir`, `pu`, `pd`, `def`, `opol`, `ipol` and `edge`
(see `protocol-reference.md`, `map set`). The store keeps the whole map as
sent by the device (`WirePinMap`, serde field names of the SDK `PinMap`);
the strip edits it through `src/lib/pinmap.ts` (`withSplit`, `withPull`,
`withEdgeNotify`), which keeps every R-M1 rule true. All masks on the wire
use physical GP bit positions; the UI indexes pins by channel and converts
only through `src/lib/pins.ts` (`chToGp`, `gpToCh`, `chBit`, word packers —
the TypeScript twin of the SDK helpers `ch_to_gp` / `gp_to_ch` /
`VALID_DIO_MASK`). Validation mirrors the device: a channel cannot be both
output and input, pull-up and pull-down are exclusive and inputs only, and
`def`/`opol` apply to outputs only; the SDK re-validates on `map set`.

### PatternEditor

**Purpose**: Create, load, and control output patterns.

**Visual Design**:
- Step table: rows of (output bits, hold time). Editable cells. One bit
  button per output channel (channel order); the hold is edited in
  microseconds and sent as pattern ticks (1 tick = 200 ns, `hold_ticks`).
  A hold that is not a whole number of ticks is rejected with an error in
  the log, never rounded (`src/lib/pattern.ts`).
- "Add Step" / "Remove Step" buttons.
- Waveform preview showing the pattern as a timing diagram.
- "Load from File" for TOML pattern files.
- "Upload to Device" sends `pattern reset`, then `pattern add` in as many
  lines as the 256-byte line limit requires (SDK `pattern_load`).
- Playback controls: Play (once), Loop, Stop, Status indicator.
- Repeat count input for loop mode.

**State**:
```typescript
interface PatternEditorState {
    steps: PatternStep[];
    acceptedSteps: number | null;
    playbackState: "idle" | "running" | "done";
    currentStep: number;
    loopsDone: number;
    mode: "once" | "loop";
    repeatCount: number;
}
```

**Behavior**:
- Editing steps updates the preview waveform immediately.
- Upload validates step count against device capabilities.
- Playback controls are disabled when no pattern is loaded.
- Status polling during playback (or use push event for completion).

### WaveformViewer

**Purpose**: Display input state changes over time as a logic analyzer
waveform.

**Visual Design**:
- Canvas 2D chart with one lane per monitored channel.
- Time axis in microseconds (or milliseconds for long captures).
- Digital waveform rendering: horizontal lines at HIGH/LOW levels with
  vertical transitions.
- Per-channel color coding.
- Time cursors (vertical lines) that can be dragged to measure intervals.
- Readout panel showing cursor positions and delta-T.

**State**:
```typescript
interface WaveformViewerState {
    channels: WaveformChannel[];
    timeRangeUs: [number, number];
    cursors: Cursor[];
    recording: boolean;
}

interface WaveformChannel {
    gpNumber: number;
    label: string;
    color: string;
    events: Array<{ timestampUs: number; value: boolean }>;
    visible: boolean;
}

interface Cursor {
    id: string;
    timestampUs: number;
    color: string;
}
```

**Behavior**:
- Recording mode: accumulate events from subscription.
- Playback mode: display pre-captured timestamp data.
- Zoom: mouse wheel on time axis. Pan: click-drag.
- Auto-scroll when recording (follows latest data).
- Clear button resets all traces.

### CommandLog

**Purpose**: Display a scrollable log of all serial commands and responses
exchanged with the device.

**Visual Design**:
- Monospace text log, similar to a terminal.
- Sent commands prefixed with `>` in accent color.
- Responses prefixed with `<` in text color.
- Errors highlighted in warn color.
- Push events prefixed with `!` in a distinct color.
- Auto-scroll to bottom. Click to pause scrolling.
- Copy button and clear button.

**State**:
```typescript
interface CommandLogState {
    entries: LogEntry[];
    autoScroll: boolean;
    maxEntries: number;  // ring buffer, default 1000
}

interface LogEntry {
    timestamp: Date;
    direction: "sent" | "received" | "event" | "error";
    text: string;
}
```

### TimestampViewer

**Purpose**: Display captured timestamp events with nanosecond precision.

**Visual Design**:
- Table view: columns for index, input snapshot (hex), raw count, raw
  phase, sync active, computed timestamp (ns), reconciled flag.
- Sortable columns.
- Highlight rows where reconcile adjusted the timestamp.
- Summary stats: event count, time span, min/max interval.
- Export to CSV/JSON buttons.

**State**:
```typescript
interface TimestampViewerState {
    result: TimestampResult | null;
    sortColumn: string;
    sortDirection: "asc" | "desc";
}
```

## 7. Data Flow

### Command Flow (Frontend to Device)

```
1. User clicks "Read" button in GpioMonitor
2. React component calls: await invoke("read_inputs")
3. Tauri routes to: #[tauri::command] fn read_inputs(state) -> IoState
4. Rust handler calls: state.connection.read()
5. pochi-sdk sends: "read\r\n" over serial
6. Device responds: "OK in=0x00000005\r\n"
7. pochi-sdk parses response -> the logical input word 5 (bit = GP pin)
8. Tauri serializes IoState to JSON and returns to frontend
9. React component updates state via the global store
10. GpioMonitor re-renders with new pin values
```

### Event Flow (Device to Frontend)

```
1. Device detects input change
2. Device sends: "! INPUT in=0x00000005 t=1234567\r\n"
3. pochi-sdk background reader receives the line
4. Rust backend parses the push event
5. Backend calls: app.emit("pochi://input", { inputs, timestampUs })
6. Frontend listener receives the event
7. The global store is updated
8. GpioMonitor + WaveformViewer re-render
```

### State Synchronization

The global store (version-key + `useSyncExternalStore`) is the single
source of truth for the frontend. All
Tauri command results and events update the store. Components subscribe
to specific store slices to minimize re-renders.

```typescript
interface AppStore {
    // Connection
    connectionStatus: ConnectionStatus;
    connectedDevice: DeviceInfo | null;

    // Device state
    ioState: IoState | null;
    pinMap: PinMap | null;
    capabilities: Capabilities | null;

    // Waveform
    waveformChannels: WaveformChannel[];
    recording: boolean;

    // Pattern
    patternSteps: PatternStep[];
    patternStatus: PatternStatus | null;

    // Timestamps
    timestampResult: TimestampResult | null;

    // Command log
    commandLog: LogEntry[];

    // Actions
    connect: (port: string) => Promise<void>;
    disconnect: () => Promise<void>;
    readState: () => Promise<void>;
    writeOutput: (values: number, mask: number) => Promise<void>;
    // ... etc
}
```

## 8. Mockup References

Visual mockups for the GUI are stored in `docs/mockups/`. Each mockup
is an SVG file showing the layout and visual design of a component or
the full application.

| File | Description |
|---|---|
| `docs/mockups/full-layout.svg` | Complete application layout |
| `docs/mockups/device-panel.svg` | Device panel in various states |
| `docs/mockups/gpio-monitor.svg` | GPIO monitor with pin states |
| `docs/mockups/waveform-viewer.svg` | Waveform viewer with cursors |
| `docs/mockups/pattern-editor.svg` | Pattern editor with step table |
| `docs/mockups/pin-map-editor.svg` | Pin map editor with drag boundary |
| `docs/mockups/timestamp-viewer.svg` | Timestamp table with reconcile |

## 9. Tauri Command Reference

Complete list of Tauri commands that the backend must implement. Each
command corresponds to one or more pochi-sdk calls.

### Discovery and Connection

```rust
#[tauri::command]
fn discover() -> Result<Vec<DeviceInfo>, String>

#[tauri::command]
fn connect(port: String) -> Result<DeviceInfo, String>

#[tauri::command]
fn disconnect() -> Result<(), String>
```

### Device Information

```rust
#[tauri::command]
fn get_version() -> Result<VersionInfo, String>

#[tauri::command]
fn get_caps() -> Result<Capabilities, String>

#[tauri::command]
fn get_info() -> Result<DeviceInfo, String>

#[tauri::command]
fn set_device_number(n: u8) -> Result<(), String>
```

### Digital I/O

```rust
#[tauri::command]
fn read_inputs() -> Result<u32, String>

#[tauri::command]
fn write_outputs(values: u32, mask: u32) -> Result<(), String>

#[tauri::command]
fn read_state() -> Result<IoState, String>

#[tauri::command]
fn subscribe(enable: bool) -> Result<(), String>
```

### Pin Map

```rust
#[tauri::command]
fn map_get() -> Result<PinMap, String>

#[tauri::command]
fn map_set(map: PinMap) -> Result<(), String>

#[tauri::command]
fn map_save() -> Result<(), String>

#[tauri::command]
fn map_default() -> Result<(), String>

/// Evaluates a map.toml (schema v2, docs/config-files.md) with the SDK
/// config parser (`pochi_sdk::config::load_map`) and returns the map
/// without touching the device; the frontend applies it via `map_set`.
/// Errors read `<path>:<line>: <message>`.
#[tauri::command]
fn map_load_toml(path: String) -> Result<PinMap, String>
```

The v1 hex form (`map_set_hex`, the 7-byte blob decoder `pin_map_from_hex`)
no longer exists: the GUI backend decodes no wire text itself, it only
calls the typed SDK methods. `PinMap` serializes with the SDK field names
`flags`, `direction`, `pull_up`, `pull_down`, `out_default`, `out_polarity`,
`in_polarity`, `edge` (all masks are GP bits).

### Pattern

```rust
#[tauri::command]
fn pattern_load(steps: Vec<PatternStep>) -> Result<u16, String>

/// `pattern reset` + `pattern add` lines (SDK `pattern_load`). A step is
/// `PatternStep { out_bits: u32 (GP bits), hold_ticks: u32 }`, 1 tick =
/// 200 ns.
// (pattern_load above)

/// Parses a pattern.toml with the SDK config parser
/// (`pochi_sdk::config::load_pattern`, holds already converted to ticks),
/// uploads it, and returns the parsed steps alongside the accepted count so
/// the editor can display what was uploaded.
#[tauri::command]
fn pattern_load_toml(path: String) -> Result<PatternTomlPayload, String>
// struct PatternTomlPayload { steps: Vec<PatternStep>, accepted: u16 }

/// repeat must be >= 1: the FW rejects repeat=0 with BAD_PARAM (there is
/// no infinite mode). The frontend maps its loop "∞" field to 65535.
#[tauri::command]
fn pattern_run(mode: PatternMode, repeat: u16) -> Result<(), String>

#[tauri::command]
fn pattern_stop() -> Result<(), String>

#[tauri::command]
fn pattern_status() -> Result<PatternStatus, String>
// struct PatternStatus { state: idle|loaded|running|done, step, loops, total }
```

### Timestamp

```rust
/// `mask` is a physical GP bit mask; the FW requires it to be non-zero and
/// a subset of the input pins (BAD_PARAM otherwise). The frontend arms
/// "all inputs" as `VALID_DIO_MASK & !direction`.
#[tauri::command]
fn ts_arm(mask: u32, mode: EdgeMode) -> Result<(), String>

/// Rows carry a per-event `reconciled` flag (false for plain ts_get).
/// One `ts get` answers at most 85 events (TS_GET_MAX), so the backend
/// drains `max_events` in protocol-sized calls and stops at the first short
/// answer; the overflow flag of any call is kept. `ns` is computed with the
/// device's `caps.ts_res_ns`.
#[tauri::command]
fn ts_get(max_events: u16) -> Result<TsResultPayload, String>

/// ts get + host-side straddle reconciliation (pochi-sdk reconcile);
/// adjusted rows are flagged `reconciled: true`.
#[tauri::command]
fn ts_get_reconciled(max_events: u16) -> Result<TsResultPayload, String>
// struct TsRow { inputs, raw_count, raw_phase, sync_active,
//                timestamp_ns, reconciled }
// struct TsResultPayload { events: Vec<TsRow>, reconciled: bool,
//                          overflow: bool }
// overflow mirrors the FW's `overflow=` field (capture ring overrun);
// the TimestampViewer shows a red OVERFLOW banner and the JSON export
// carries the flag.

#[tauri::command]
fn ts_disarm() -> Result<(), String>
```

### Sync

```rust
#[tauri::command]
fn sync_arm() -> Result<(), String>

#[tauri::command]
fn sync_master() -> Result<(), String>

#[tauri::command]
fn sync_start() -> Result<(), String>

#[tauri::command]
fn sync_stop() -> Result<(), String>

#[tauri::command]
fn sync_count() -> Result<u64, String>

#[tauri::command]
fn sync_disarm() -> Result<(), String>
```

### Utility

```rust
#[tauri::command]
fn raw_command(text: String) -> Result<String, String>

/// Write export payloads (CSV/JSON built by the frontend) to a path
/// chosen via the save dialog.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String>
```

### Backend → Frontend Events

| Event | Payload | Source |
|---|---|---|
| `pochi://log` | `{ direction: "sent"\|"received"\|"event"\|"error", line }` | SDK traffic hook (every wire line) + scan probe failures |
| `pochi://input` | `{ inputs, timestampUs }` | `! INPUT` push |
| `pochi://pattern-done` | `{ loops }` | `! PATTERN_DONE` push |
| `pochi://pattern-timeout` | `{ loops }` | `! PATTERN_TIMEOUT` push |
| `pochi://unknown-event` | `{ raw }` | unrecognized push lines |

`inputs` is the logical input word, bit = GP pin. v2 has no sync push event
(the v1 `SyncDone` / `pochi://sync-done` are gone).

### Wire types seen by the frontend

The backend returns the SDK types as serde JSON; the frontend mirrors them
in `src/store/store.ts` / `src/lib/pinmap.ts` / `src/lib/pattern.ts`:

| Type | Fields |
|---|---|
| `VersionInfo` | `major, minor, patch, protocol_version` (2) |
| `Capabilities` | `dio` (25), `out`, `in`, `ts_res_ns` (40), `tick_ns` (200), `pattern_max`, `ring`, `features` (bit 0 sync, bit 1 reset) |
| `IoState` | `inputs, outputs` (GP-bit words) |
| `PinMap` | `flags, direction, pull_up, pull_down, out_default, out_polarity, in_polarity, edge` |
| `PatternStep` | `out_bits` (GP bits), `hold_ticks` |
| `PatternStatus` | `state, step, loops, total` |

## 10. Backend State Management

The Tauri backend maintains a shared application state that holds the
active connection and device information.

```rust
use std::sync::Mutex;
use tauri::State;

struct AppState {
    connection: Option<Connection>,
    device_info: Option<DeviceInfo>,
}

type ManagedState = State<'_, Mutex<AppState>>;

#[tauri::command]
fn read_state(state: ManagedState) -> Result<IoState, String> {
    let mut app = state.lock().map_err(|e| e.to_string())?;
    let conn = app.connection.as_mut().ok_or("Not connected")?;
    conn.state().map_err(|e| e.to_string())
}
```

For push events, a background thread reads from the serial port and emits
Tauri events:

```rust
fn start_event_listener(app: tauri::AppHandle, rx: mpsc::Receiver<PushEvent>) {
    std::thread::spawn(move || {
        while let Ok(event) = rx.recv() {
            match event {
                PushEvent::InputChange { inputs, t_us } => {
                    app.emit("pochi://input", json!({ "inputs": inputs, "timestampUs": t_us })).ok();
                }
                PushEvent::PatternDone { loops } => {
                    app.emit("pochi://pattern-done", json!({ "loops": loops })).ok();
                }
                // PatternTimeout, Unknown ...; there is no sync event in v2
            }
        }
    });
}
```
