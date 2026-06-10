# System Architecture

## 1. Overview

Pochi Tools is a monorepo providing multi-language SDKs and a GUI application
for **Pochi-DIO**, an RP2350-based high-speed digital I/O unit. Pochi-DIO
offers 23 GPIO pins (GP0-GP22) with microsecond-level timestamping, output
pattern generation, and multi-device clock synchronization over a single USB
connection.

### Related Repositories

| Repository | Description |
|---|---|
| [pochi-dio](https://github.com/alphaelements/pochi-dio) | Firmware (Rust, no_std, bare-metal RP2350) |
| [pochi-cli](https://github.com/alphaelements/pochi-cli) | Standalone CLI tool (Rust, std) |
| **pochi-tools** (this repo) | SDKs (Rust/TS/Python/C#) + GUI application |

## 2. System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Host Applications                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐│
│  │ GUI App  │  │ CLI Tool │  │ MCP Srv  │  │ User Apps   ││
│  │ (Tauri)  │  │(pochi-cli│  │ (future) │  │ (custom)    ││
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘│
│       │              │              │               │       │
│  ┌────┴──────────────┴──────────────┴───────────────┴────┐  │
│  │                    Pochi SDK                          │  │
│  │  Rust │ TypeScript │ Python │ C#                      │  │
│  │  ─────────────────────────────────                    │  │
│  │  discovery │ transport │ protocol │ events │ types    │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │ USB CDC (serial port)           │
└───────────────────────────┼─────────────────────────────────┘
                            │
                   ┌────────┴────────┐
                   │   Pochi-DIO     │
                   │   (RP2350)      │
                   │   23 GPIO pins  │
                   └─────────────────┘
```

The host communicates with Pochi-DIO over USB CDC using a text-based command
protocol. The SDK abstracts the serial port handling, command framing,
response parsing, and event subscription into a clean API. The GUI and CLI
are thin layers on top of the SDK.

## 3. SDK Architecture

The SDK follows a 4-layer design. Each language implementation mirrors the
same layers to ensure consistent behavior and API surface.

### Layer 1 -- Discovery

Enumerates USB serial ports and identifies Pochi-DIO devices by filtering on
USB VID (`0x2E8A`), PID (`0x000A`), and product string prefix (`"Pochi"`).
Returns a list of `DeviceInfo` objects containing UID, device number, port
path, and firmware version.

### Layer 2 -- Transport

Manages the serial port connection (open, close, read, write). Sends
text-mode commands (`{command}\r\n`) and reads response lines. Handles line
buffering and timeout. The transport layer is protocol-agnostic -- it deals
only with line-level I/O.

### Layer 3 -- Protocol

Maps typed API calls to text commands and parses response strings into typed
results. For example, `connection.caps()` sends `caps\r\n`, receives
`OK dio=23 out=12 in=11 ts_res=40ns ...`, and returns a `Capabilities`
struct. This layer also translates `ERR <code>` responses into typed error
values.

Some commands produce multi-line responses: `ts get` returns `OK count=N`
followed by N event lines. The protocol layer handles counted reads for these
cases.

### Layer 4 -- Events

Manages asynchronous push events from the device (`! INPUT ...`,
`! PATTERN_DONE ...`, `! SYNC_DONE ...`). The implementation is
language-specific:

| Language | Event Mechanism |
|---|---|
| Rust | `tokio::sync::mpsc` channel / `Stream` trait |
| TypeScript | `EventEmitter` / async iterator |
| Python | `asyncio.Queue` |
| C# | `IObservable<T>` (Reactive Extensions pattern) |

### Host-Side Processing

The SDK also implements host-side computations that are required by the
Phase 9.6 protocol:

- **32-to-64-bit count extension**: `raw_count` is u32 and wraps after
  ~71.6 minutes. The SDK tracks the high bits and extends to u64.
- **Nanosecond calculation**: `timestamp_ns = raw_count * 1000 + raw_phase * 40`
- **Reconcile (straddle correction)**: When DMA captures cross a microsecond
  boundary, the SDK generates candidate timestamps and selects the
  combination that minimizes pairwise differences across channels/devices.

## 4. GUI Architecture

The GUI is a desktop application built with **Tauri v2** (Rust backend) and
**React 19** (TypeScript frontend).

### Data Flow

```
┌─────────────────────────────────────────────────┐
│                   Frontend                       │
│  React 19 + TypeScript + Vite                   │
│  Zustand (state) │ uPlot (waveforms)            │
│                                                  │
│  invoke("read_inputs") ──────────────────┐       │
│  listen("input-change", cb) ◄────────────┼──┐    │
└──────────────────────────────────────────┼──┼────┘
                    Tauri IPC              │  │
┌──────────────────────────────────────────┼──┼────┐
│                   Backend                │  │    │
│  Tauri v2 (Rust)                        │  │    │
│                                          │  │    │
│  #[tauri::command]                       │  │    │
│  fn read_inputs(state) -> IoState  ◄─────┘  │    │
│                                             │    │
│  // push events:                            │    │
│  app.emit("input-change", payload) ─────────┘    │
│                                                  │
│  pochi-sdk (Rust) ──► serial port ──► device     │
└──────────────────────────────────────────────────┘
```

- **Frontend to Backend**: The React frontend calls Tauri commands via
  `invoke()`. Each command is a Rust function annotated with
  `#[tauri::command]` that delegates to `pochi-sdk`.
- **Backend to Frontend**: Push events from the device (input changes,
  pattern completion, sync events) are forwarded to the frontend via
  `app.emit()`. The frontend subscribes with `listen()`.
- **State Management**: Zustand stores on the frontend hold device state,
  connection status, and UI state. Tauri commands return typed responses
  that update the store.

## 5. Monorepo Structure

```
pochi-tools/
├── Cargo.toml              # Rust workspace root (members: sdk/rust, gui/src-tauri)
├── Cargo.lock              # Committed -- reproducible builds
├── deny.toml               # cargo-deny configuration (license auditing)
├── lefthook.yml            # Pre-commit hooks (clippy, fmt, test)
├── LICENSE-MIT
├── LICENSE-APACHE
│
├── sdk/
│   ├── rust/               # Reference SDK implementation
│   │   ├── Cargo.toml      # pochi-sdk crate
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── types.rs    # All shared types (DeviceInfo, Capabilities, etc.)
│   │       └── error.rs    # SdkError enum with typed device error codes
│   │
│   ├── typescript/         # TypeScript SDK (@pochi/sdk)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │
│   ├── python/             # Python SDK (pochi-sdk)
│   │   ├── pyproject.toml
│   │   └── src/
│   │
│   └── csharp/             # C# SDK (Pochi.Sdk)
│       ├── Pochi.Sdk.sln
│       ├── src/Pochi.Sdk/
│       └── tests/Pochi.Sdk.Tests/
│
├── gui/
│   ├── package.json        # Frontend (React + Vite)
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   ├── src/                # React components, styles, state
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── styles/
│   ├── public/
│   └── src-tauri/          # Tauri backend (Rust)
│       ├── Cargo.toml      # pochi-gui crate (depends on pochi-sdk)
│       ├── tauri.conf.json
│       └── src/
│           ├── main.rs
│           └── lib.rs
│
├── docs/
│   ├── architecture.md     # This document
│   ├── protocol-reference.md
│   ├── sdk-api-design.md
│   ├── gui-feature-spec.md
│   └── mockups/            # SVG mockups for GUI design
│
└── tmp/                    # Scratch files (git-ignored)
```

### Workspace Configuration

The Rust workspace (`Cargo.toml` at the root) includes two members:

- `sdk/rust` -- the `pochi-sdk` crate, the foundation for all host-side logic
- `gui/src-tauri` -- the `pochi-gui` crate, which depends on `pochi-sdk`

Node packages are managed separately:

- `gui/` -- Vite + React frontend with `@tauri-apps/api` and
  `@tauri-apps/plugin-shell`
- `sdk/typescript/` -- standalone TypeScript SDK (`@pochi/sdk`)

Python and C# packages have their own build systems (`pyproject.toml` and
`.sln`/`.csproj` respectively).

## 6. Third-Party Dependency Management

### Lockfiles

All lockfiles are committed to ensure reproducible builds:

| Language | Lockfile | Location |
|---|---|---|
| Rust | `Cargo.lock` | Repository root |
| Node (GUI) | `package-lock.json` | `gui/` |
| Node (TS SDK) | `package-lock.json` | `sdk/typescript/` |
| Python | (pinned in `pyproject.toml`) | `sdk/python/` |
| C# | (version pinning in `.csproj`) | `sdk/csharp/` |

### License Auditing

- **Rust**: `cargo-deny` with `deny.toml` at the repository root.
  Configured to allow only MIT and Apache-2.0 licenses.
- **Node**: Standard npm audit. License compliance checked in CI.
- **Python**: Dependencies limited to well-known permissive-licensed packages
  (`pyserial` is BSD-3-Clause).
- **C#**: NuGet packages audited manually. License metadata in `.csproj`.

### Pre-Commit Hooks

`lefthook.yml` runs the following checks before each commit:

- `cargo clippy --all-targets -- -D warnings` (zero warnings policy)
- `cargo fmt --all -- --check`
- `cargo test`

## 7. Cross-Language Consistency

All four SDK implementations share identical:

- **Type names**: `DeviceInfo`, `Capabilities`, `IoState`, `PinMap`,
  `PatternStep`, `TimestampEvent`, `PatternStatus`, etc. (adapted to
  language naming conventions)
- **Method signatures**: Same parameters and return types for all operations
- **Error types**: Typed error enum/class with variants for each device
  error code (`BadCommand`, `BadParam`, `BadMap`, `Busy`, etc.) plus
  connection/parse/timeout errors
- **Response structures**: All types serialize to identical JSON, enabling
  cross-language interoperability and consistent `--json` output
- **Behavior**: Edge cases, timeouts, error handling, and event semantics
  are documented in `docs/sdk-api-design.md` and must be implemented
  identically

The Rust SDK is the **reference implementation**. Other SDKs should match
its behavior exactly, verified by a shared test suite of expected
command/response pairs.
