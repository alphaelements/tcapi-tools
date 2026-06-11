# Cross-Language SDK API Design

This document defines the API surface, type system, and behavioral
contracts for all Pochi SDK implementations. The Rust SDK is the reference
implementation; TypeScript, Python, and C# SDKs must match its behavior
exactly.

## 1. Design Principles

1. **Consistent API across all languages.** Same types, same methods, same
   error semantics. A developer who learns one SDK can use any other
   immediately.

2. **Language-idiomatic naming.** Types and methods follow each language's
   conventions:
   - Rust / Python: `snake_case` methods, `PascalCase` types
   - TypeScript / C#: `camelCase` methods, `PascalCase` types

3. **Typed errors.** Every error has a specific variant. No stringly-typed
   errors. Error types map 1:1 to device error codes plus SDK-specific
   conditions.

4. **Async-first for events.** Event subscriptions use the language's native
   async primitive. Synchronous wrappers are provided where idiomatic.

5. **Zero silent failures.** Every error is propagated. Parsing failures,
   timeouts, and unexpected responses always produce an error, never a
   default value.

6. **JSON round-trip fidelity.** All types serialize to identical JSON
   regardless of language. This enables cross-language interoperability
   and consistent tooling output.

## 2. Core Types

### DeviceInfo

Represents a discovered Pochi-DIO device.

**Rust:**
```rust
pub struct DeviceInfo {
    pub uid: String,
    pub device_number: Option<u8>,
    pub port: String,
    pub version: Option<String>,
}
```

**TypeScript:**
```typescript
interface DeviceInfo {
    uid: string;
    deviceNumber: number | null;
    port: string;
    version: string | null;
}
```

**Python:**
```python
@dataclass
class DeviceInfo:
    uid: str
    device_number: int | None
    port: str
    version: str | None
```

**C#:**
```csharp
public record DeviceInfo(
    string Uid,
    byte? DeviceNumber,
    string Port,
    string? Version
);
```

JSON representation:
```json
{
    "uid": "AABBCCDD11223344",
    "device_number": 1,
    "port": "/dev/ttyACM0",
    "version": "v0.1.0"
}
```

`device_number` is `null` when the device number is unassigned (firmware
value 255).

### VersionInfo

```rust
pub struct VersionInfo {
    pub major: u8,
    pub minor: u8,
    pub patch: u8,
    pub protocol_version: u8,
}
```

### Capabilities

```rust
pub struct Capabilities {
    pub protocol_version: u8,
    pub max_dio: u8,
    pub out_count: u8,
    pub in_count: u8,
    pub ts_resolution_ns: u32,
    pub max_pattern_steps: u16,
    pub ts_ring_events: u16,
    pub features: u32,
}
```

Helper method: `has_sync() -> bool` returns `true` if bit 0 of `features`
is set.

### IoState

```rust
pub struct IoState {
    pub inputs: u32,
    pub outputs: u32,
    pub flags: u8,
}
```

### PinMap

```rust
pub struct PinMap {
    pub version: u8,
    pub out_base: u8,
    pub out_count: u8,
    pub in_base: u8,
    pub in_count: u8,
    pub pull: PullMode,
    pub flags: u8,
}

pub enum PullMode {
    None,
    Up,
    Down,
}
```

### PatternStep

```rust
pub struct PatternStep {
    pub out_bits: u32,
    pub hold_us: u32,
}
```

### PatternStatus

```rust
pub struct PatternStatus {
    pub state: PatternState,
    pub current_step: u16,
    pub loops_done: u16,
}

pub enum PatternState {
    Idle,
    Loaded,
    Running,
    Done,
}

pub enum PatternMode {
    Once,
    Loop,
}
```

### TimestampEvent

```rust
pub struct TimestampEvent {
    pub inputs: u32,
    pub raw_count: u32,
    pub raw_phase: u8,
    pub sync_active: bool,
    pub timestamp_ns: i64,
}
```

`timestamp_ns` is computed by the SDK using:
`raw_count * 1000 + raw_phase * 40`. After reconcile, this value may be
adjusted.

### TimestampResult

```rust
pub struct TimestampResult {
    pub events: Vec<TimestampEvent>,
    pub reconciled: bool,
}
```

### EdgeMode

```rust
pub enum EdgeMode {
    Rising,
    Falling,
    Both,
}
```

### Sync Types

```rust
pub enum SyncRole {
    Master,
    Slave,
}

pub enum SyncState {
    Idle,
    Armed,
    MasterArmed,
    Clocking,
}
```

## 3. API Surface

### Discovery

```
discover() -> DeviceInfo[]
```

Enumerates all connected Pochi-DIO devices. Filters USB serial ports by
VID (`0x2E8A`), PID (`0x000A`), and product string prefix (`"Pochi"`).
Sends `info` and `version` to each matching port to populate `DeviceInfo`.
Results are sorted by port path in every SDK: the OS enumeration order is
unspecified, and callers (and the hardware smoke tests) rely on a
deterministic device order when several devices are connected.

**Rust:**
```rust
pub fn discover() -> Result<Vec<DeviceInfo>>

/// Variant that also reports matching ports that failed to open or
/// respond (e.g. held open by another process) instead of hiding them.
pub fn discover_detailed() -> Result<Discovery>

pub struct Discovery {
    pub devices: Vec<DeviceInfo>,
    pub failures: Vec<ProbeFailure>, // (port, error) pairs
}
```

**TypeScript:**
```typescript
async function discover(): Promise<DeviceInfo[]>
```

**Python:**
```python
def discover() -> list[DeviceInfo]
```

**C#:**
```csharp
public static class Discovery {
    public static DeviceInfo[] Discover();

    /// Variant that also reports matching ports that failed to open or
    /// respond, mirroring the Rust discover_detailed().
    public static DiscoveryResult DiscoverDetailed();
}

public sealed record DiscoveryResult(
    IReadOnlyList<DeviceInfo> Devices,
    IReadOnlyList<ProbeFailure> Failures
);
```

C# enumeration reads Linux sysfs directly (`System.IO.Ports` exposes no
USB descriptors). On other platforms `Discover()` throws a `Connection`
error instead of silently returning an empty list — connect by explicit
port path (`Connection.Open(path)`) there.

### Connection

```
connect(selector) -> Connection
```

Opens a connection to a specific device. The selector can be a port path,
UID, or device number.

**Rust:**
```rust
impl Connection {
    pub fn open(port: &str) -> Result<Connection>
    pub fn open_by_uid(uid: &str) -> Result<Connection>
    pub fn open_by_device_number(n: u8) -> Result<Connection>
    /// Connect to the only device; NoDevice / MultipleDevices otherwise.
    pub fn open_sole_device() -> Result<Connection>
}
```

**TypeScript:**
```typescript
class Connection {
    static async open(port: string): Promise<Connection>
    static async openByUid(uid: string): Promise<Connection>
    static async openByDeviceNumber(n: number): Promise<Connection>
}
```

**Python:**
```python
class Connection:
    @staticmethod
    def open(port: str) -> "Connection"
    @staticmethod
    def open_by_uid(uid: str) -> "Connection"
    @staticmethod
    def open_by_device_number(n: int) -> "Connection"
```

**C#:**
```csharp
public class Connection : IDisposable {
    public static Connection Open(string port)
    public static Connection OpenByUid(string uid)
    public static Connection OpenByDeviceNumber(byte n)
}
```

### Device Information Commands

```rust
impl Connection {
    pub fn version(&mut self) -> Result<VersionInfo>
    pub fn caps(&mut self) -> Result<Capabilities>
    pub fn info(&mut self) -> Result<DeviceInfo>
    pub fn set_device_number(&mut self, n: u8) -> Result<()>
}
```

### Digital I/O Commands

```rust
impl Connection {
    pub fn read(&mut self) -> Result<u32>
    pub fn write(&mut self, values: u32, mask: u32) -> Result<()>
    pub fn state(&mut self) -> Result<IoState>
}
```

### Pin Map Commands

```rust
impl Connection {
    pub fn map_get(&mut self) -> Result<PinMap>
    pub fn map_set(&mut self, map: &PinMap) -> Result<()>
    pub fn map_set_hex(&mut self, hex: &str) -> Result<()>
    pub fn map_save(&mut self) -> Result<()>
    pub fn map_default(&mut self) -> Result<()>
}
```

### Pattern Commands

```rust
impl Connection {
    pub fn pattern_load(&mut self, steps: &[PatternStep]) -> Result<u16>
    pub fn pattern_load_hex(&mut self, hex: &str) -> Result<u16>
    pub fn pattern_run(&mut self, mode: PatternMode, repeat: u16) -> Result<()>
    pub fn pattern_stop(&mut self) -> Result<()>
    pub fn pattern_status(&mut self) -> Result<PatternStatus>
}
```

`pattern_load` returns the number of accepted steps.

### Timestamp Commands

```rust
impl Connection {
    pub fn ts_arm(&mut self, mask: u32, mode: EdgeMode) -> Result<()>
    pub fn ts_get(&mut self, max_events: u16) -> Result<TimestampResult>
    pub fn ts_disarm(&mut self) -> Result<()>
}
```

`ts_get` reads the multi-line response, parses all event lines, computes
`timestamp_ns` for each event, and returns the complete result.

### Event Subscription

```rust
impl Connection {
    pub fn subscribe(&mut self, enable: bool) -> Result<()>
}
```

When subscribed, push events (`! INPUT ...`) arrive on the serial port
between command/response pairs. The event delivery mechanism is
language-specific (see Section 5).

### Sync Commands

```rust
impl Connection {
    pub fn sync_arm(&mut self) -> Result<()>
    pub fn sync_master(&mut self) -> Result<()>
    pub fn sync_start(&mut self) -> Result<()>
    pub fn sync_stop(&mut self) -> Result<()>
    pub fn sync_count(&mut self) -> Result<u64>
    pub fn sync_disarm(&mut self) -> Result<()>
}
```

### Raw Command

```rust
impl Connection {
    pub fn raw(&mut self, command: &str) -> Result<String>
}
```

Sends an arbitrary text command and returns the raw response string.
Useful for debugging and forward compatibility with new firmware commands.

### Traffic Hook (Rust)

```rust
pub enum TrafficDirection { Sent, Received, Event }
pub type TrafficHook = Arc<dyn Fn(TrafficDirection, &str) + Send + Sync>;

impl Connection {
    pub fn set_traffic_hook(&mut self, hook: Option<TrafficHook>)
}
```

Installs an observer for every line exchanged with the device: command
lines written (`Sent`, without the trailing CRLF), response/data lines
(`Received`), and push lines (`Event`, including the `! ` prefix). The
GUI uses this to feed its command log. The hook is called synchronously —
`Sent`/`Received` from the calling thread, `Event` from the reader
thread — so it must be fast and must not call back into the connection.
A second call replaces the hook; `None` removes it. Rust-only for now;
other languages expose equivalent logging via their event layers when
needed.

### Connection Lifecycle

```rust
impl Connection {
    pub fn close(self) -> Result<()>
}
```

In languages with resource management (`Drop` in Rust, `IDisposable` in C#,
context managers in Python), the connection automatically closes when the
object is dropped/disposed.

## 4. Error Handling

### Error Type

All SDKs define a typed error enum/class with variants for every device
error code plus SDK-specific conditions.

**Rust:**
```rust
pub enum SdkError {
    // Device errors (from ERR responses)
    BadCommand,
    BadParam,
    BadMap,
    Busy,
    Flash,
    TooLong,
    NotArmed,
    SyncState,
    SyncTimeout,
    NoResource,
    UnknownDevice(String),

    // SDK errors
    Connection(serialport::Error),
    Io(std::io::Error),
    Parse(String),
    Timeout,
    NoDevice,
    MultipleDevices,
    Disconnected,
    UnsupportedFirmware(String),
}
```

**TypeScript:**
```typescript
class SdkError extends Error {
    readonly code: ErrorCode;
}

enum ErrorCode {
    BadCommand = "BAD_CMD",
    BadParam = "BAD_PARAM",
    BadMap = "BAD_MAP",
    Busy = "BUSY",
    Flash = "FLASH",
    TooLong = "TOO_LONG",
    NotArmed = "NOT_ARMED",
    SyncState = "SYNC_STATE",
    SyncTimeout = "SYNC_TIMEOUT",
    NoResource = "NO_RESOURCE",
    UnknownDevice = "UNKNOWN_DEVICE",
    Connection = "CONNECTION",
    Io = "IO",
    Parse = "PARSE",
    Timeout = "TIMEOUT",
    NoDevice = "NO_DEVICE",
    MultipleDevices = "MULTIPLE_DEVICES",
    Disconnected = "DISCONNECTED",
    UnsupportedFirmware = "UNSUPPORTED_FIRMWARE",
}
```

**Python:**
```python
class SdkError(Exception):
    code: str
    message: str

class BadCommandError(SdkError): ...
class BadParamError(SdkError): ...
class BadMapError(SdkError): ...
class BusyError(SdkError): ...
class FlashError(SdkError): ...
class TooLongError(SdkError): ...
class NotArmedError(SdkError): ...
class SyncStateError(SdkError): ...
class SyncTimeoutError(SdkError): ...
class NoResourceError(SdkError): ...
class ConnectionError(SdkError): ...
class ParseError(SdkError): ...
class TimeoutError(SdkError): ...
class NoDeviceError(SdkError): ...
class MultipleDevicesError(SdkError): ...
class DisconnectedError(SdkError): ...
class UnsupportedFirmwareError(SdkError): ...
```

**C#:**
```csharp
public class SdkException : Exception {
    public ErrorCode Code { get; }
}

public enum ErrorCode {
    BadCommand,
    BadParam,
    BadMap,
    Busy,
    Flash,
    TooLong,
    NotArmed,
    SyncState,
    SyncTimeout,
    NoResource,
    UnknownDevice,
    Connection,
    Io,
    Parse,
    Timeout,
    NoDevice,
    MultipleDevices,
    Disconnected,
    UnsupportedFirmware,
}
```

### Error Code Mapping

The SDK parses `ERR <name>` responses and maps them to the appropriate
error variant:

| ERR response | Error variant |
|---|---|
| `ERR BAD_CMD` | BadCommand |
| `ERR UNKNOWN_CMD` | BadCommand |
| `ERR BAD_PARAM` | BadParam |
| `ERR BAD_MAP` | BadMap |
| `ERR BUSY` | Busy |
| `ERR FLASH` | Flash |
| `ERR TOO_LONG` | TooLong |
| `ERR LINE_TOO_LONG` | TooLong |
| `ERR NOT_ARMED` | NotArmed |
| `ERR SYNC_STATE` | SyncState |
| `ERR SYNC_TIMEOUT` | SyncTimeout |
| `ERR NO_RESOURCE` | NoResource |
| Unrecognized | UnknownDevice(raw string) |

### SDK-Specific Errors

| Error | Condition |
|---|---|
| Connection | Serial port open/close failure |
| Io | Read/write error on the serial port |
| Parse | Response does not match expected format |
| Timeout | No response received within the timeout period |
| NoDevice | No Pochi-DIO device found during discovery |
| MultipleDevices | Multiple devices found but no selector specified |
| Disconnected | Device went away mid-session (unplug, reader thread exit) |
| UnsupportedFirmware | Pre-Phase 9.6 firmware detected (`ts_res=1000` in caps, or `t=` timestamp event format). Never parsed silently |

## 5. Event Model

### Rust

```rust
use std::sync::mpsc;

impl Connection {
    /// Install a push event subscriber on the existing reader thread.
    /// Returns a receiver that yields events as they arrive (including
    /// while commands are in flight). A second call replaces the first
    /// subscriber. No async runtime dependency.
    pub fn subscribe_events(&mut self) -> mpsc::Receiver<PushEvent>
}

pub enum PushEvent {
    InputChange { inputs: u32, timestamp_us: u64 },
    PatternDone { loops: u16 },
    SyncDone { status: String, devnum: u8, timestamp: u64 },
    /// Unrecognized or malformed push line, preserved verbatim so newer
    /// firmware events are observable instead of silently dropped.
    Unknown { raw: String },
}
```

### TypeScript

```typescript
import { EventEmitter } from "events";

interface ConnectionEvents {
    "input-change": (event: InputChangeEvent) => void;
    "pattern-done": (event: PatternDoneEvent) => void;
    "sync-done": (event: SyncDoneEvent) => void;
}

class Connection extends EventEmitter<ConnectionEvents> {
    // Events are emitted automatically when push lines arrive
}

// Usage:
connection.on("input-change", (event) => {
    console.log(`Input: 0x${event.inputs.toString(16)}`);
});
```

### Python

```python
import asyncio

class Connection:
    async def subscribe_events(self) -> asyncio.Queue[PushEvent]:
        """Start background reader, return queue of push events."""
        ...

@dataclass
class InputChangeEvent:
    inputs: int
    timestamp_us: int

@dataclass
class PatternDoneEvent:
    loops: int

@dataclass
class SyncDoneEvent:
    status: str
    devnum: int
    timestamp: int

PushEvent = InputChangeEvent | PatternDoneEvent | SyncDoneEvent
```

### C#

```csharp
public class Connection : IDisposable {
    public IObservable<PushEvent> Events { get; }
}

public abstract record PushEvent;
public record InputChangeEvent(uint Inputs, ulong TimestampUs) : PushEvent;
public record PatternDoneEvent(ushort Loops) : PushEvent;
public record SyncDoneEvent(string Status, byte Devnum, ulong Timestamp) : PushEvent;

// Usage:
connection.Events
    .OfType<InputChangeEvent>()
    .Subscribe(e => Console.WriteLine($"Input: 0x{e.Inputs:X}"));
```

## 6. JSON Serialization

All types must serialize to identical JSON across all languages. This
ensures that:

- CLI `--json` output is consistent regardless of which SDK is used
- Cross-language test suites can share expected output files
- GUI frontend receives the same data structure from the Tauri backend

### Serialization Rules

1. **Property names**: Always `snake_case` in JSON (matching Rust's serde
   defaults). TypeScript/C# SDKs transform to/from `camelCase` at the
   API boundary but serialize as `snake_case`.

2. **Nullable values**: Use JSON `null` (not absent keys).
   `device_number: null` when unassigned (firmware value 255).

3. **Enums**: Serialize as lowercase strings.
   `"state": "running"`, `"pull": "up"`, `"mode": "rising"`

4. **Hex values**: Serialize as decimal integers in JSON.
   `"inputs": 5` (not `"inputs": "0x05"`).

5. **Boolean flags**: Standard JSON booleans.
   `"sync_active": true`

### Example JSON Output

```json
{
    "events": [
        {
            "inputs": 5,
            "raw_count": 1000,
            "raw_phase": 7,
            "sync_active": true,
            "timestamp_ns": 1000280
        },
        {
            "inputs": 10,
            "raw_count": 2000,
            "raw_phase": 12,
            "sync_active": false,
            "timestamp_ns": 2000480
        }
    ],
    "reconciled": false
}
```

## 7. Reconcile API

The reconcile engine is part of the SDK, not just the CLI. Any application
can use it.

The Rust signatures below are normative (ported from `pochi-cli` together
with its test vectors); other languages mirror them with idiomatic naming
and container types. All SDKs must produce identical results for the
shared test vectors.

```rust
/// Generate 3 candidate timestamps for a (count, phase) pair:
/// [as-is, count-1, count+1].
pub fn candidates(count: u32, phase: u8) -> [i64; 3]

/// Naive (uncorrected) ns value: count * 1000 + phase * 40.
pub fn as_is_ns(count: u32, phase: u8) -> i64

/// Given K events from the same physical time, find the combination
/// of candidates that minimizes total pairwise |diff|.
/// Returns K reconciled timestamps in nanoseconds.
/// K=1 and K>8 return as-is values; ties prefer as-is.
pub fn reconcile(events: &[(u32, u8)]) -> Vec<i64>

/// One timestamp event tagged with its origin (device x channel).
pub struct SourceEvent {
    pub device: String,      // UID, or "local" for single-device use
    pub channel: String,     // e.g. "GP0" (best-effort label)
    pub inputs: String,      // input snapshot, "0x..." form
    pub raw_count: u32,
    pub raw_phase: u8,
    pub sync_active: bool,
}

/// A group of events attributed to the same physical instant.
pub struct ReconcileGroup {
    pub approx_count: u32,
    pub events: Vec<SourceEvent>,
    pub reconciled_ns: Vec<i64>,
    pub reconciled: bool,        // false when no correction was possible
    pub warning: Option<String>, // why correction was skipped
}

/// Group events by raw_count proximity (gap >= 2 starts a new group)
/// and reconcile within each group. Groups with mixed sync_active, or
/// sync_active=0 across different devices, or K>8 are left as-is with
/// a warning.
pub fn group_events(events: &[SourceEvent]) -> Vec<ReconcileGroup>

/// Per-source-pair diff statistics across all groups (mean, stdev,
/// max |diff|, % within 500ns).
pub fn pair_stats(groups: &[ReconcileGroup]) -> Vec<PairStats>

/// Extend wrapping u32 raw counts to u64 (one instance per device per
/// count source).
pub struct CountExtender;
impl CountExtender {
    pub fn new() -> Self
    pub fn extend(&mut self, raw: u32) -> u64
}
```
