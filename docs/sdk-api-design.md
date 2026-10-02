# Cross-Language SDK API Design

This document defines the API surface, type system, and behavioral
contracts for all Pochi SDK implementations. The Rust SDK is the reference
implementation; TypeScript, Python, and C# SDKs must match its behavior
exactly.

It describes protocol **v2** (`proto=2`) only. The wire protocol is defined in
[`protocol-reference.md`](protocol-reference.md); the TOML file formats in
[`config-files.md`](config-files.md). There is no v1 type, constant or
fallback in any SDK.

## 1. Design Principles

1. **Consistent API across all languages.** Same types, same methods, same
   error semantics. A developer who learns one SDK can use any other
   immediately.

2. **Language-idiomatic naming.** Types and methods follow each language's
   conventions:
   - Rust / Python: `snake_case` methods, `PascalCase` types
   - TypeScript / C#: `camelCase` methods, `PascalCase` types

3. **Typed errors.** Every error has a specific variant. No stringly-typed
   errors. Error types map 1:1 to device error names plus SDK-specific
   conditions.

4. **Async-first for events.** Event subscriptions use the language's native
   async primitive. Synchronous wrappers are provided where idiomatic.

5. **Zero silent failures.** Every error is propagated. Parsing failures,
   timeouts, out-of-range values, unknown responses and unknown events always
   produce an error, never a default value.

6. **JSON round-trip fidelity.** All types serialize to identical JSON
   regardless of language. This enables cross-language interoperability
   and consistent tooling output.

7. **Physical GP bits on the wire.** Every mask the SDK sends or returns is a
   physical GP bit position (section 2, Pin conventions). Logical channels
   ch0-ch24 are a display concept; applications convert with the SDK pin
   helpers and never re-implement the bit arithmetic.

8. **One protocol version.** An SDK accepts the `proto` value it was built
   for (2) and nothing else. Adding, renaming or removing a key, command or
   event bumps the protocol version.

## 2. Core Types

### Pin conventions

| Channel | GP pin | Bit |
|---|---|---|
| ch0-ch22 | GP0-GP22 | bit0-bit22 |
| ch23 | GP26 | bit26 |
| ch24 | GP27 | bit27 |
| (not DIO) | GP23, GP24, GP25, GP28 | always 0 in every mask |

Every SDK exports:

```rust
pub const PROTO_VERSION: u8 = 2;
pub const DIO_CHANNELS: u8 = 25;
pub const VALID_DIO_MASK: u32 = 0x0C7F_FFFF;
pub const PATTERN_TICK_NS: u32 = 200;
pub fn ch_to_gp(ch: u8) -> Result<u8>      // 0-24 -> 0-22, 26, 27
pub fn gp_to_ch(gp: u8) -> Result<u8>      // inverse; GP23/24/25/28 are errors
pub fn pin_label(gp: u8) -> Result<String> // e.g. "GP26 (ch23)"
```

The CLI, GUI and VS Code extension use only these. A mask with a bit outside
`VALID_DIO_MASK` is rejected by the SDK (`InvalidArgument`) before anything is sent; the device
rejects it as well (`BadParam` / `BadMap`).

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
    "version": "0.1.3"
}
```

`device_number` is `null` when the device number is unassigned (firmware
value 255). `version` is the `fw=` value of the `version` command.

### VersionInfo

```rust
pub struct VersionInfo {
    pub major: u8,
    pub minor: u8,
    pub patch: u8,
    pub protocol_version: u8,   // always 2
}
```

### Capabilities

Parsed from `caps` (`OK dio=25 out=<n> in=<n> ts_res_ns=40 tick_ns=200
pattern=<n> ring=<n> feat=0x%08x`).

```rust
pub struct Capabilities {
    pub dio: u8,                // 25
    pub out: u8,                // number of output pins
    pub r#in: u8,               // number of input pins (Python: `in_`)
    pub ts_res_ns: u32,         // 40
    pub tick_ns: u32,           // 200
    pub pattern_max: u16,       // wire key `pattern`
    pub ring: u16,
    pub features: u32,          // wire key `feat`
}
```

Helper methods on `Capabilities`:

- `has_sync() -> bool` — bit 0 (`FEAT_SYNC = 0x1`): multi-device clock
  sync (`sync` commands).
- `has_reset() -> bool` — bit 1 (`FEAT_RESET = 0x2`): reset commands.

Both bit values are exported as public constants (`FEAT_SYNC`, `FEAT_RESET`
in Rust/Python/TS; `Feature.Sync` / `Feature.Reset` in C#) so callers can
test feature support without hard-coded literals.

### IoState

Parsed from `state` (`OK in=0x%08x out=0x%08x`). Physical GP bits, logical
levels.

```rust
pub struct IoState {
    pub inputs: u32,
    pub outputs: u32,
}
```

### PinMap

The v2 pin map. The type name has no version suffix. Parsed from `map get`
and sent with `map set`.

```rust
pub struct PinMap {
    pub flags: u8,          // reserved, must be 0
    pub direction: u32,     // key `dir`, 1 = output
    pub pull_up: u32,       // key `pu`
    pub pull_down: u32,     // key `pd`
    pub out_default: u32,   // key `def`
    pub out_polarity: u32,  // key `opol`
    pub in_polarity: u32,   // key `ipol`
    pub edge: u32,          // key `edge`, inputs that raise ! INPUT events
}

impl PinMap {
    /// `PinMap::default()`: the map applied at power-up without a saved
    /// map: every DIO pin an input with pull-down and edge enabled.

    /// Same rules as the firmware (BAD_MAP); error on the first violation.
    pub fn validate(&self) -> Result<()>

    /// Validates, then formats
    /// `flags=0x00 dir=0x... pu=0x... pd=0x... def=0x... opol=0x... ipol=0x... edge=0x...`
    pub fn to_set_args(&self) -> Result<String>

    /// Parse the text after `OK ` of a `map get` response.
    pub fn parse_get(args: &str) -> Result<PinMap>
}
```

`validate()` rules (R-M1), the same in every language and the same as the
firmware:

| Field | Rule |
|---|---|
| `flags` | 0 |
| `direction` | subset of `VALID_DIO_MASK` |
| `pull_up` | subset of `VALID_DIO_MASK & !direction`; `pull_up & pull_down == 0` |
| `pull_down` | subset of `VALID_DIO_MASK & !direction` |
| `out_default` | subset of `direction` |
| `out_polarity` | subset of `direction` |
| `in_polarity` | subset of `VALID_DIO_MASK & !direction` |
| `edge` | subset of `VALID_DIO_MASK & !direction` |

`map get` output pasted back into `map set` yields the same map
(round trip): `parse_get(x).to_set_args()` equals the key list of `x`.

### PatternStep

```rust
pub struct PatternStep {
    pub out_bits: u32,      // logical output levels, physical GP bits, subset of direction
    pub hold_ticks: u32,    // >= 1; one tick = 200 ns (Capabilities.tick_ns)
}

/// Nanoseconds -> ticks. Only the hold part is converted: an exact multiple
/// of 200 ns, at least one tick, not above u32 ticks; anything else is an
/// error (never rounded).
pub fn hold_ticks_from_ns(ns: u64) -> Result<u32>

impl PatternStep {
    pub fn validate(&self) -> Result<()>    // DIO bits only, hold_ticks >= 1
    pub fn to_text(&self) -> Result<String> // "0x1:5", the `pattern add` form
    pub fn hold_ns(&self) -> u64            // hold_ticks * 200 (tick part only)
}
```

The primary representation in every API is the tick. One step lasts
`hold_ticks x 200 ns + 133 ns` on the device; the 133 ns per step is not
modelled by the helper.

### PatternStatus

```rust
pub struct PatternStatus {
    pub state: PatternState,
    pub step: u16,          // step being output while running, else 0
    pub loops: u16,         // completed passes
    pub total: u16,         // steps in the buffer
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

One line of a `ts get` response (`in=0x%08x c=<u32> p=<0-24> s=<0|1>`).

```rust
pub struct TimestampEvent {
    pub inputs: u32,        // logical levels of the armed pins, other bits 0
    pub raw_count: u32,
    pub raw_phase: u8,
    pub sync_active: bool,
}

impl TimestampEvent {
    /// raw_count * 1000 + raw_phase * ts_res_ns
    pub fn ns(&self, ts_res_ns: u32) -> i64
}
```

The event carries no pre-computed nanosecond field and the SDK has no
resolution constant: the caller passes `Capabilities.ts_res_ns`.

### TimestampResult

```rust
pub struct TimestampResult {
    pub events: Vec<TimestampEvent>,
    pub overflow: bool,     // ring overwrote events since the last ts get
}
```

### TsStatus

Parsed from `ts status` (`OK armed=<0|1> pending=<n> overflow=<0|1>`).

```rust
pub struct TsStatus {
    pub armed: bool,
    pub pending: u32,
    pub overflow: bool,
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

Enumerates all connected Pochi-DIO devices. A port matches when VID is
`0x2E8A`, PID is `0x000A` and, if the operating system provides a product
string, it starts with `"Pochi"`. Each matching port is then opened with DTR
asserted and probed with `version`; a device that does not report `proto=2`
is not returned as usable (it appears among the failures). `info` is sent to
populate `DeviceInfo`.
Results are sorted by port path in every SDK: the OS enumeration order is
unspecified, and callers (and the hardware smoke tests) rely on a
deterministic device order when several devices are connected.

**Rust:**
```rust
pub fn discover() -> Result<Vec<DeviceInfo>>

/// Variant that also reports matching ports that failed to open or
/// respond (e.g. held open by another process) or run another protocol
/// version, instead of hiding them.
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
UID, or device number. Opening asserts DTR and issues `version`; any
`proto` other than 2 fails with `UnsupportedFirmware`
("unsupported protocol").

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

### Transport Contract

Normative for every SDK (R-H1 to R-H4).

- **One command, one response.** A response is exactly one of the two forms
  of the protocol: a single `OK ...` / `ERR <NAME>` line, or a header with
  `count=<N>` followed by exactly N continuation lines. A counted response
  reads exactly N lines. There is no drain-and-discard of "extra" lines.
- **Resynchronisation.** A timeout, an unparseable line, or a short counted
  response puts the connection in a `desync` state. The next operation first
  sends `ping <random u32>` and discards every response line until
  `OK pong=<same value>` arrives (push events are routed to the event path
  meanwhile). If that fails the connection is closed (`Disconnected`). Every
  SDK test suite injects stale lines through its fake device to prove this.
- **DTR.** The connection asserts DTR when it opens; the device sends no
  events without it.
- **Subscription ownership.** The SDK owns `subscribe`. The subscriber count
  of the connection goes 0 to 1: `subscribe on` is sent; 1 to 0:
  `subscribe off`. There is one subscription per connection, fanned out to
  all subscribers. There is no public `subscribe(bool)`, and `raw()` rejects
  `subscribe` locally (`InvalidArgument`).
- **Raw commands.** `raw()` follows the same rules and returns **all** lines
  of the response (section Raw Command).
- **Events.** An unknown event line is logged as an error and discarded; it is
  never delivered to a subscriber and never queued as a response.

### Device Information Commands

```rust
impl Connection {
    pub fn version(&mut self) -> Result<VersionInfo>
    pub fn caps(&mut self) -> Result<Capabilities>
    pub fn info(&mut self) -> Result<DeviceInfo>
    pub fn set_device_number(&mut self, n: u8) -> Result<()>
    pub fn ping(&mut self, value: u32) -> Result<u32>   // returns the echoed value
}
```

`ping` returns the `pong` value and fails with `Parse` when it differs. It is
also the resynchronisation primitive of the transport.

### Digital I/O Commands

```rust
impl Connection {
    pub fn read(&mut self) -> Result<u32>
    pub fn write(&mut self, values: u32, mask: u32) -> Result<()>
    pub fn state(&mut self) -> Result<IoState>
}
```

`write` rejects, before sending, a mask with bits outside `VALID_DIO_MASK`.
A mask covering a non-output pin is refused by the device (`BadParam`);
no output pin configured is `NoResource`.

### Pin Map Commands

```rust
impl Connection {
    pub fn map_get(&mut self) -> Result<PinMap>
    pub fn map_set(&mut self, map: &PinMap) -> Result<()>
    pub fn map_save(&mut self) -> Result<()>
    pub fn map_default(&mut self) -> Result<()>
}
```

`map_set` calls `PinMap::validate()` first and sends
`map set <to_set_args()>`. `map_set` and `map_default` fail with `Busy`
while a pattern is running; on success the device returns the pattern engine
to idle (loaded steps are gone) and disarms the timestamp recorder.
There is no hex-string form.

### Pattern Commands

Patterns are transferred only by appending (`pattern add`); the device has
no command that replaces the whole buffer in one step.

```rust
impl Connection {
    /// One `pattern add` line. Atomic on the device. Returns `total`.
    pub fn pattern_add(&mut self, steps: &[PatternStep]) -> Result<u16>

    /// `pattern_reset`, then `pattern_add` in as many chunks as needed, each
    /// chunk packed to at most 256 bytes per line. Returns the final total.
    pub fn pattern_load(&mut self, steps: &[PatternStep]) -> Result<u16>

    pub fn pattern_run(&mut self, mode: PatternMode, repeat: u16) -> Result<()>
    pub fn pattern_run_once(&mut self) -> Result<()>
    pub fn pattern_run_loop(&mut self, repeat: u16) -> Result<()>
    pub fn pattern_stop(&mut self) -> Result<()>
    pub fn pattern_status(&mut self) -> Result<PatternStatus>
    pub fn pattern_reset(&mut self) -> Result<()>
}
```

Notes:

- `pattern_add` fails with `BadParam` for a step on a non-output pin or
  `hold_ticks == 0`, `Busy` while running, and `TooLong` when the total would
  exceed `Capabilities.pattern_max`. The failing call adds nothing. Steps with
  bits outside `VALID_DIO_MASK` are rejected locally.
- `out_bits` are logical levels, as for `write`; the device applies the map
  output polarity.
- `pattern_run(Once, _)` plays one pass (the repeat is ignored); `Loop`
  requires `repeat` of 1-65535. The command text is `pattern run once` and
  `pattern run loop <repeat>`.
- `pattern_stop` on a non-running engine returns `SdkError::NotRunning`
  (`ERR NOT_RUNNING`). Callers should guard with a state check, or treat
  `NotRunning` as benign. Steps stay loaded after a stop.
- `pattern_reset` aborts any run, clears the buffer and returns to `Idle`.
  USB stays up.
- Completion arrives as a `PatternDone` event; a firmware safety timeout as
  `PatternTimeout`.

### Reset Commands

```rust
impl Connection {
    pub fn reset(self) -> Result<()>
    pub fn bootsel(self) -> Result<()>
}
```

Both commands trigger a USB re-enumeration (so the Rust SDK consumes
`self`; other languages document that the connection must be reopened).
`reset` reboots the device (RAM state returns to defaults, flash state is
kept); `bootsel` reboots into BOOTSEL mass-storage mode for UF2 reflash.

### Timestamp Commands

```rust
impl Connection {
    pub fn ts_arm(&mut self, mask: u32, mode: EdgeMode) -> Result<()>
    pub fn ts_get(&mut self, max_events: u16) -> Result<TimestampResult>
    pub fn ts_status(&mut self) -> Result<TsStatus>
    pub fn ts_disarm(&mut self) -> Result<()>
}
```

`ts_arm` requires a non-zero `mask` inside the input pins. `ts_get` accepts
`max_events` 1-85 (anything else is rejected locally), reads the counted
response, and returns the parsed events with the `overflow` flag. It does
not compute nanoseconds: use `TimestampEvent::ns(ts_res_ns)` or the
reconcile API with `Capabilities.ts_res_ns`.

### Event Subscription

Events are obtained from `subscribe_events()` (section 5). The first
subscriber turns the device subscription on, the last one turns it off.
Push events (`! INPUT ...`) arrive between command/response pairs; the
delivery mechanism is language-specific.

### Sync Commands

```rust
impl Connection {
    pub fn sync_arm(&mut self) -> Result<()>
    pub fn sync_master(&mut self) -> Result<()>
    pub fn sync_start(&mut self) -> Result<()>
    pub fn sync_stop(&mut self) -> Result<()>
    pub fn sync_count(&mut self) -> Result<u64>      // `OK clocks=<u64>`
    pub fn sync_disarm(&mut self) -> Result<()>
}
```

`sync_count` parses the single line `OK clocks=<n>`; it is not a counted
response. Wrong-state calls fail with `SyncState`.

### Help

```rust
impl Connection {
    /// `help`: the device command list, one entry per line (counted
    /// response), without the two-space wire indent.
    pub fn help(&mut self) -> Result<Vec<String>>
}
```

### Raw Command

```rust
impl Connection {
    pub fn raw(&mut self, command: &str) -> Result<Vec<String>>
}
```

Sends an arbitrary text command and returns **every line** of the response
(for a counted response: the header and all N continuation lines) under the
same rules as every other command. A line longer than 256 bytes is rejected
locally (`InvalidArgument`). `subscribe` is rejected the same way: the SDK owns the subscription. This is the
only way applications send protocol text; REPL front-ends use it.

### Config Files (Rust)

```rust
pub mod config {
    pub fn parse_map(src: &str, file: &str) -> Result<PinMap, ConfigError>
    pub fn parse_pattern(src: &str, file: &str) -> Result<Vec<PatternStep>, ConfigError>
    pub fn load_map(path: &Path) -> Result<PinMap>
    pub fn load_pattern(path: &Path) -> Result<Vec<PatternStep>>

    pub struct ConfigError { pub file: String, pub line: usize, pub message: String }
    // Display: "<file>:<line>: <message>"
}
```

Implements [`config-files.md`](config-files.md) exactly (schema v2, no lenient
mode). Every fixture in `docs/fixtures/` yields the documented masks, steps,
message and line (`sdk/rust/tests/config_fixtures.rs`). `ConfigError` converts
into `SdkError::Parse` with the same text.

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

All SDKs define a typed error enum/class with a variant for every error name
the device can answer over the text protocol, plus SDK-specific conditions.

**Rust:**
```rust
pub enum SdkError {
    // Device errors (from ERR responses)
    BadParam,
    BadMap,
    Busy,
    Flash,
    TooLong,
    NotArmed,
    SyncState,
    NoResource,
    NotRunning,
    UnknownCmd,
    LineTooLong,
    // Binary / HID transports only; a text device never answers them
    BadCommand,
    TransportNotSupported,
    UnknownDevice(String),  // any other ERR <NAME>, raw name preserved

    // SDK errors
    Connection(serialport::Error),
    Io(std::io::Error),
    Parse(String),
    InvalidArgument(String),   // rejected by host-side validation, nothing sent
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
    BadParam = "BAD_PARAM",
    BadMap = "BAD_MAP",
    Busy = "BUSY",
    Flash = "FLASH",
    TooLong = "TOO_LONG",
    NotArmed = "NOT_ARMED",
    SyncState = "SYNC_STATE",
    NoResource = "NO_RESOURCE",
    NotRunning = "NOT_RUNNING",
    UnknownCmd = "UNKNOWN_CMD",
    LineTooLong = "LINE_TOO_LONG",
    BadCommand = "BAD_CMD",
    TransportNotSupported = "TRANSPORT_NOT_SUPPORTED",
    UnknownDevice = "UNKNOWN_DEVICE",
    Connection = "CONNECTION",
    Io = "IO",
    Parse = "PARSE",
    InvalidArgument = "INVALID_ARGUMENT",
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

class BadParamError(SdkError): ...
class BadMapError(SdkError): ...
class BusyError(SdkError): ...
class FlashError(SdkError): ...
class TooLongError(SdkError): ...
class NotArmedError(SdkError): ...
class SyncStateError(SdkError): ...
class NoResourceError(SdkError): ...
class NotRunningError(SdkError): ...
class UnknownCmdError(SdkError): ...
class LineTooLongError(SdkError): ...
class BadCommandError(SdkError): ...
class TransportNotSupportedError(SdkError): ...
class UnknownDeviceError(SdkError): ...
class ConnectionError(SdkError): ...
class ParseError(SdkError): ...
class InvalidArgumentError(SdkError): ...
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
    BadParam,
    BadMap,
    Busy,
    Flash,
    TooLong,
    NotArmed,
    SyncState,
    NoResource,
    NotRunning,
    UnknownCmd,
    LineTooLong,
    BadCommand,
    TransportNotSupported,
    UnknownDevice,
    Connection,
    Io,
    Parse,
    InvalidArgument,
    Timeout,
    NoDevice,
    MultipleDevices,
    Disconnected,
    UnsupportedFirmware,
}
```

### Error Code Mapping

The SDK parses `ERR <name>` responses and maps them 1:1:

| ERR response | Error variant |
|---|---|
| `ERR BAD_PARAM` | BadParam |
| `ERR BAD_MAP` | BadMap |
| `ERR BUSY` | Busy |
| `ERR FLASH` | Flash |
| `ERR TOO_LONG` | TooLong |
| `ERR NOT_ARMED` | NotArmed |
| `ERR SYNC_STATE` | SyncState |
| `ERR NO_RESOURCE` | NoResource |
| `ERR NOT_RUNNING` | NotRunning |
| `ERR UNKNOWN_CMD` | UnknownCmd |
| `ERR LINE_TOO_LONG` | LineTooLong |
| `ERR BAD_CMD` | BadCommand |
| `ERR TRANSPORT_NOT_SUPPORTED` | TransportNotSupported |
| Anything else | UnknownDevice(raw name) |

There is no `SYNC_TIMEOUT` error: a slave that sees no sync edge returns to
idle without reporting an error.

### SDK-Specific Errors

| Error | Condition |
|---|---|
| Connection | Serial port open/close failure |
| Io | Read/write error on the serial port |
| Parse | Response does not match the expected format (including unknown keys and wrong counted-line counts) |
| InvalidArgument | Host-side validation failed before anything was sent (mask outside `VALID_DIO_MASK`, `PinMap::validate()` violation, `hold_ticks` 0, `ts_get` max outside 1-85, ns not a multiple of 200, line over 256 bytes, ...) |
| Timeout | No response received within the timeout period |
| NoDevice | No Pochi-DIO device found during discovery |
| MultipleDevices | Multiple devices found but no selector specified |
| Disconnected | Device went away mid-session (unplug, reader thread exit), or resynchronisation failed |
| UnsupportedFirmware | `version` reported a `proto` other than 2 ("unsupported protocol"). Never parsed leniently |

## 5. Event Model

The device sends exactly three events: `! INPUT in=0x%08x t=<u64 us>`,
`! PATTERN_DONE loops=<n>` and `! PATTERN_TIMEOUT loops=<n>`. There is no
other event type. `INPUT` carries the logical levels of all input pins and is
sent when `((in ^ previous) & edge) != 0` for the active map; `t` is the
detection time in microseconds.

### Rust

```rust
use std::sync::mpsc;

impl Connection {
    /// Attach a push event subscriber on the existing reader thread.
    /// Returns a receiver that yields events as they arrive (including
    /// while commands are in flight). The first subscriber sends
    /// `subscribe on`; once the last receiver is dropped, `subscribe off`
    /// is sent before the next operation (the drop is noticed when the
    /// reader next fails to deliver an event, so the switch-off is lazy).
    /// No async runtime dependency.
    pub fn subscribe_events(&mut self) -> Result<mpsc::Receiver<PushEvent>>
}

pub enum PushEvent {
    InputChange { inputs: u32, t_us: u64 },
    PatternDone { loops: u16 },
    /// Pattern aborted by the firmware wall-clock safety budget. The output
    /// latch keeps the last step; recover with `write` or `pattern_reset`.
    PatternTimeout { loops: u16 },
}
```

### TypeScript

```typescript
import { EventEmitter } from "events";

interface ConnectionEvents {
    "input-change": (event: InputChangeEvent) => void;
    "pattern-done": (event: PatternDoneEvent) => void;
    "pattern-timeout": (event: PatternTimeoutEvent) => void;
}

class Connection extends EventEmitter<ConnectionEvents> {
    // Events are emitted automatically when push lines arrive.
    // The device subscription follows the listener count of
    // "input-change" (0 -> 1: subscribe on, 1 -> 0: subscribe off).
}

// Usage:
connection.on("input-change", (event) => {
    console.log(`Input: 0x${event.inputs.toString(16)}`);
});
```

### Python

```python
class Connection:
    def subscribe_events(self) -> EventSubscription:
        """Attach a subscriber. The first one sends `subscribe on`."""
        ...

class EventSubscription:
    def get(self, timeout: float | None = None) -> PushEvent: ...  # queue.Empty on timeout
    def get_nowait(self) -> PushEvent: ...
    def close(self) -> None: ...   # the last one to close sends `subscribe off`
    # context manager: `with conn.subscribe_events() as events: ...`

@dataclass
class InputChangeEvent:
    inputs: int
    t_us: int

@dataclass
class PatternDoneEvent:
    loops: int

@dataclass
class PatternTimeoutEvent:
    loops: int

PushEvent = InputChangeEvent | PatternDoneEvent | PatternTimeoutEvent
```

### C#

```csharp
public class Connection : IDisposable {
    public IObservable<PushEvent> Events { get; }
}

public abstract record PushEvent;
public record InputChangeEvent(uint Inputs, ulong TUs) : PushEvent;
public record PatternDoneEvent(ushort Loops) : PushEvent;
public record PatternTimeoutEvent(ushort Loops) : PushEvent;

// Usage:
connection.Events
    .OfType<InputChangeEvent>()
    .Subscribe(e => Console.WriteLine($"Input: 0x{e.Inputs:X}"));
```

An unrecognised event line is logged as an error and dropped in every
language; it is neither delivered to subscribers nor treated as a response.

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
   `"state": "running"`, `"mode": "rising"`

4. **Hex values**: Serialize as decimal integers in JSON.
   `"inputs": 5` (not `"inputs": "0x05"`).

5. **Boolean flags**: Standard JSON booleans.
   `"sync_active": true`

### Example JSON Output

A `ts get` result (the four events are the golden transcript of timestamps
taken while the sync clock runs and after `sync stop`; the nanosecond value is
not part of the type):

```json
{
    "events": [
        { "inputs": 1, "raw_count": 2,   "raw_phase": 12, "sync_active": true },
        { "inputs": 0, "raw_count": 3,   "raw_phase": 24, "sync_active": true },
        { "inputs": 1, "raw_count": 4,   "raw_phase": 0,  "sync_active": true },
        { "inputs": 0, "raw_count": 107, "raw_phase": 0,  "sync_active": false }
    ],
    "overflow": false
}
```

The corresponding wire response:

```
> ts get 10
< OK count=4 overflow=0
<   in=0x00000001 c=2 p=12 s=1
<   in=0x00000000 c=3 p=24 s=1
<   in=0x00000001 c=4 p=0 s=1
<   in=0x00000000 c=107 p=0 s=0
```

With `ts_res_ns = 40`, `ns()` of the first event is `2 * 1000 + 12 * 40 = 2480`.

A `map get` result:

```json
{
    "flags": 0,
    "direction": 15,
    "pull_up": 240,
    "pull_down": 209714944,
    "out_default": 5,
    "out_polarity": 8,
    "in_polarity": 256,
    "edge": 209715184
}
```

for the wire response:

```
> map get
< OK v=2 flags=0x00 dir=0x0000000f pu=0x000000f0 pd=0x0c7fff00 def=0x00000005 opol=0x00000008 ipol=0x00000100 edge=0x0c7ffff0
```

## 7. Reconcile API

The reconcile engine is part of the SDK, not just the CLI. Any application
can use it.

The Rust signatures below are normative (ported from `pochi-cli` together
with its test vectors); other languages mirror them with idiomatic naming
and container types. All SDKs must produce identical results for the
shared test vectors.

The phase resolution is an **argument** (`ts_res_ns`, from
`Capabilities.ts_res_ns`) of every function that converts phase to
nanoseconds. No SDK defines a phase-step constant.

```rust
/// Generate 3 candidate timestamps for a (count, phase) pair:
/// [as-is, count-1, count+1].
pub fn candidates(count: u32, phase: u8, ts_res_ns: u32) -> [i64; 3]

/// Naive (uncorrected) ns value: count * 1000 + phase * ts_res_ns.
pub fn as_is_ns(count: u32, phase: u8, ts_res_ns: u32) -> i64

/// Given K events from the same physical time, find the combination
/// of candidates that minimizes total pairwise |diff|.
/// Returns K reconciled timestamps in nanoseconds.
/// K=1 and K>8 return as-is values; ties prefer as-is.
pub fn reconcile(events: &[(u32, u8)], ts_res_ns: u32) -> Vec<i64>

/// One timestamp event tagged with its origin (device x channel).
pub struct SourceEvent {
    pub device: String,      // UID, or "local" for single-device use
    pub channel: String,     // pin label, e.g. "GP26 (ch23)"
    pub inputs: u32,         // logical levels, physical GP bits
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
pub fn group_events(events: &[SourceEvent], ts_res_ns: u32) -> Vec<ReconcileGroup>

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

## 8. Conformance

The SDK test suites check the implementation against the golden transcripts in
`protocol/golden/` (the same files the firmware and the simulator replay):

- every fake device used in a test generates its responses from the golden
  files, or has a conformance test that does;
- a hand-written response line is allowed only in a test marked as negative
  (malformed-input) coverage;
- `scripts/sync-protocol-golden.sh --check` (parent workspace) must show no
  difference between the distributed copies.
