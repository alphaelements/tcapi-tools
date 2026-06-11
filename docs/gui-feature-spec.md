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

- **Unit (frontend)**: vitest, `npm test` — scoped to `src/**/*.test.ts`.
- **Unit (backend)**: `cargo test -p pochi-gui` — event routing, map hex
  decode, reconcile rows, state.
- **E2E**: Playwright, `npm run test:e2e` — runs the full UI against a
  browser-only virtual device (`src/lib/mock-device.ts`, activated with
  `/?mock` on the dev server). The mock implements every Tauri command,
  mirrors the rig's loopback wiring (output ch c → input ch c) and the
  FW's BAD_PARAM behaviours, and exposes `window.__POCHI_MOCK__` test
  hooks (forced ts overflow, saved-file capture, direct edge injection).
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
| GPIO state display | GpioMonitor | Show all 23 pins with direction and state |
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
| Pattern loading | PatternEditor | Load patterns from TOML, send to device |
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

**Purpose**: Display real-time state of all 23 GPIO pins.

**Visual Design**:
- Grid of 23 pin indicators arranged in a single row or 2 rows
  (configurable).
- Each pin shows: GP number, direction (IN/OUT/--), current state
  (filled circle = HIGH, empty circle = LOW).
- Color: HIGH = `#22c55e`, LOW = `#64748b`, unassigned = `#374151`.
- Tooltip on hover shows full pin info (GP number, direction, pull mode,
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
fn get_pin_map() -> Result<PinMap, String>

#[tauri::command]
fn subscribe(enable: bool) -> Result<(), String>
```

**Tauri Events** (backend to frontend):
```rust
app.emit("input-change", InputChangePayload { inputs: u32, timestamp_us: u64 });
```

### OutputControl

**Purpose**: Control individual output pins.

**Visual Design**:
- Vertical list of output pins (only those configured as output in the
  current pin map).
- Each row: GP label, toggle switch, current state indicator.
- "Set All High" / "Set All Low" / "Invert All" bulk action buttons.
- Hex value input field for direct bit pattern entry.

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
- Visual representation of GP0-GP22 as a horizontal strip.
- Drag a boundary marker to set output/input split point.
- Dropdown for pull mode (up/down/none).
- Checkboxes for flags (timestamp enable, change notify default).
- "Apply" button sends `map set`, "Save to Flash" sends `map save`.
- "Reset to Default" sends `map default`.
- "Load from File" opens a file dialog for TOML map files.

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
- Validation: prevent overlapping ranges, out-of-bound pins.

### PatternEditor

**Purpose**: Create, load, and control output patterns.

**Visual Design**:
- Step table: rows of (output bits, hold time). Editable cells.
- "Add Step" / "Remove Step" buttons.
- Waveform preview showing the pattern as a timing diagram.
- "Load from File" for TOML pattern files.
- "Upload to Device" sends `pattern load`.
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
6. Device responds: "OK 0x000005\r\n"
7. pochi-sdk parses response -> IoState { inputs: 5, ... }
8. Tauri serializes IoState to JSON and returns to frontend
9. React component updates state via the global store
10. GpioMonitor re-renders with new pin values
```

### Event Flow (Device to Frontend)

```
1. Device detects input change
2. Device sends: "! INPUT 0x000005 t=1234567890\r\n"
3. pochi-sdk background reader receives the line
4. Rust backend parses the push event
5. Backend calls: app.emit("input-change", payload)
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
fn map_set_hex(hex: String) -> Result<(), String>

#[tauri::command]
fn map_save() -> Result<(), String>

#[tauri::command]
fn map_default() -> Result<(), String>

#[tauri::command]
fn map_load_toml(path: String) -> Result<PinMap, String>
```

### Pattern

```rust
#[tauri::command]
fn pattern_load(steps: Vec<PatternStep>) -> Result<u16, String>

/// Returns the parsed steps alongside the accepted count so the editor
/// can display what was uploaded.
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
```

### Timestamp

```rust
/// mask bits beyond caps.in_count are rejected by the FW (BAD_PARAM)
/// even when the pin map assigns more inputs; the frontend clamps its
/// all-inputs mask to min(map inputs, caps.in_count).
#[tauri::command]
fn ts_arm(mask: u32, mode: EdgeMode) -> Result<(), String>

/// Rows carry a per-event `reconciled` flag (false for plain ts_get).
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
| `pochi://sync-done` | `{ status, devnum, timestamp }` | `! SYNC_DONE` push |
| `pochi://unknown-event` | `{ raw }` | unrecognized push lines |

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
                PushEvent::InputChange { inputs, timestamp_us } => {
                    app.emit("input-change", InputChangePayload {
                        inputs,
                        timestamp_us,
                    }).ok();
                }
                PushEvent::PatternDone { loops } => {
                    app.emit("pattern-done", PatternDonePayload { loops }).ok();
                }
                // ...
            }
        }
    });
}
```
