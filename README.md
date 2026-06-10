# Pochi Tools

<!-- TODO: uncomment when CI is wired
[![CI](https://github.com/alphaelements/pochi-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/alphaelements/pochi-tools/actions)
-->
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](LICENSE-MIT)

Multi-language SDK and GUI application for **Pochi-DIO**, an RP2350-based
high-speed digital I/O unit.

## Features

- **Rust SDK** — reference implementation with full protocol support
- **TypeScript/Node.js SDK** — for Electron apps and Node-based tooling
- **Python SDK** — for scripting, automation, and Jupyter integration
- **C# SDK** — for .NET and Unity applications
- **Desktop GUI** — cross-platform app built with Tauri v2 + React
- **CLI** — see [pochi-cli](https://github.com/alphaelements/pochi-cli) for the standalone command-line tool

## SDK Languages

| Language   | Path              | Status      |
|------------|-------------------|-------------|
| Rust       | `sdk/rust/`       | In progress |
| TypeScript | `sdk/typescript/` | Planned     |
| Python     | `sdk/python/`     | Planned     |
| C#         | `sdk/csharp/`     | Planned     |

## GUI

The desktop GUI is built with [Tauri v2](https://v2.tauri.app/) + React +
TypeScript. It provides a visual interface for device configuration, real-time
signal monitoring, and pattern editing.

- Frontend: `gui/src/` (React + TypeScript)
- Backend: `gui/src-tauri/` (Rust, wraps the Rust SDK)

## Directory Structure

```
pochi-tools/
├── sdk/
│   ├── rust/           # Rust SDK (reference implementation)
│   ├── typescript/     # TypeScript/Node.js SDK
│   ├── python/         # Python SDK
│   └── csharp/         # C# SDK
├── gui/
│   ├── src/            # React frontend
│   └── src-tauri/      # Tauri backend (Rust)
├── docs/               # Architecture and design docs
├── Cargo.toml          # Workspace root
├── deny.toml           # cargo-deny configuration
└── lefthook.yml        # Git hooks
```

## Building from Source

### Prerequisites

- Rust 1.80+ (via [rustup](https://rustup.rs/))
- Node.js 20+ and npm
- Platform-specific Tauri dependencies (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

### Rust SDK

```bash
cargo build --workspace
cargo test --workspace
```

### GUI

```bash
cd gui
npm install
npm run tauri dev    # development mode
npm run tauri build  # production build
```

## License

Licensed under either of

- [Apache License, Version 2.0](LICENSE-APACHE)
- [MIT License](LICENSE-MIT)

at your option.

## Contributing

Contribution guidelines are coming soon. In the meantime, please open an issue
to discuss proposed changes before submitting a pull request.
