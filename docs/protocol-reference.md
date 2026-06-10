# Pochi-DIO CDC Text Protocol Reference

Self-contained reference for the CDC text command protocol used to
communicate with Pochi-DIO devices. This document covers everything
SDK developers need to implement a host-side driver.

## 1. Overview

Pochi-DIO exposes a USB CDC-ACM (virtual serial port) interface. The host
sends text commands over this serial port and receives text responses. No
binary framing, COBS encoding, or CRC computation is required on the host
side when using text mode.

**Protocol summary:**

- Send: `{command} [{args}]\r\n`
- Receive: `OK [{data}]\r\n` (success), `ERR {code}\r\n` (error),
  or `! {event}\r\n` (push notification)

## 2. Connection

### USB Identification

| Property | Value |
|---|---|
| VID | `0x2E8A` (Raspberry Pi) |
| PID | `0x000A` |
| Product string | Starts with `"Pochi"` |
| Serial number | 16-character hex string derived from RP2350 chip UID |

### Opening the Port

Baud rate is irrelevant for CDC virtual serial ports (USB full-speed bulk
transfer). Any baud rate value will work. The host should:

1. Enumerate serial ports and filter by VID/PID/product string.
2. Open the matching port with any baud rate (e.g., 115200 by convention).
3. Set a read timeout (recommended: 1000ms for commands, longer for
   event-driven operations).

### Line Ending

All commands and responses use `\r\n` (CRLF) as the line terminator.
The device accepts `\r`, `\n`, or `\r\n` as input line endings.
Empty lines (bare `\r` or `\n`) are silently ignored.

### Command Syntax

```
<command> [<subcommand>] [<arg1> <arg2> ...]\r\n
```

- Command names are **case-insensitive** (`VERSION`, `version`, `Version`
  are equivalent).
- Arguments are space-separated.
- Numeric arguments accept decimal (`255`) or hex with `0x` prefix (`0xFF`).
- Maximum line length: 128 bytes. Exceeding this returns `ERR LINE_TOO_LONG`.

## 3. Response Format

### Success Response

```
OK [<command-specific data>]\r\n
```

Some commands return a bare `OK\r\n` with no additional data. Others return
structured key-value data after `OK`.

### Multi-Line Responses

Some commands return additional data lines after the initial `OK` line.
The `OK` line includes a count indicating how many data lines follow.

Example (`ts get`):
```
OK count=2\r\n
  0x00000005 c=1000 p=7 s=1\r\n
  0x0000000A c=2000 p=12 s=0\r\n
```

**Important**: Only `ts get` currently uses this multi-line format.
All other commands return a single `OK` line.

### Error Response

```
ERR <error_name>\r\n
```

### Push Events

```
! <event_type> <event_data>\r\n
```

Push events are sent asynchronously by the device when subscribed
(`subscribe on`) or when timestamp/pattern/sync events complete. They
can arrive at any time between command/response pairs.

## 4. Command Reference

### Device Information

#### `version`

Get firmware version and protocol version.

```
> version
OK v0.1.0 proto=1
```

Response fields:
- `v<major>.<minor>.<patch>` -- firmware version
- `proto=<n>` -- protocol version number

#### `caps`

Get device capabilities.

```
> caps
OK dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000001
```

Response fields:
- `dio=<n>` -- maximum DIO pin count (always 23)
- `out=<n>` -- current output channel count (from active pin map)
- `in=<n>` -- current input channel count (from active pin map)
- `ts_res=<n>ns` -- timestamp phase resolution in nanoseconds
  (40ns = one sub-microsecond phase step)
- `pattern=<n>` -- maximum pattern steps
- `ring=<n>` -- timestamp ring buffer capacity (events)
- `feat=0x<hex>` -- feature flags (bit 0: sync capability)

#### `info`

Get device identification (chip UID and user-assigned device number).

```
> info
OK uid=AABBCCDD11223344 devnum=42
```

Response fields:
- `uid=<hex>` -- 16-character hex string, hardware-unique chip identifier
- `devnum=<n>` -- user-assigned device number (0-254), or `255` if unassigned

#### `devnum <n>`

Set the device number. Persisted to flash immediately.

```
> devnum 1
OK
> devnum 255
OK
```

Arguments:
- `<n>` -- device number (0-254 = valid, 255 = unassign/reset)

Errors: `ERR BAD_PARAM` (invalid value), `ERR FLASH` (flash write failed)

### Pin Map

#### `map get`

Get the current pin map configuration.

```
> map get
OK v=1 out=0:12 in=12:11 pull=up flags=0x01
```

Response fields:
- `v=<n>` -- map structure version
- `out=<base>:<count>` -- output pin range (base GP number : channel count)
- `in=<base>:<count>` -- input pin range
- `pull=<up|down|none>` -- input pull resistor mode
- `flags=0x<hex>` -- bit 0: timestamp enabled, bit 1: change notification default ON

#### `map set <hex>`

Set the pin map from a 48-character hex string (24 bytes).

```
> map set 010C0C0B02010000000000000000000000000000000000000000
OK
```

Arguments:
- `<hex>` -- 48 hex characters encoding the 24-byte binary map structure

The binary map structure (24 bytes, little-endian):

| Offset | Size | Field | Description |
|---|---|---|---|
| 0 | 1 | version | Map structure version (1) |
| 1 | 1 | out_base | First output GP number (0-22) |
| 2 | 1 | out_count | Number of output channels (0-23) |
| 3 | 1 | in_base | First input GP number (0-22) |
| 4 | 1 | in_count | Number of input channels (0-23) |
| 5 | 1 | input_pull | 0=none, 1=up, 2=down |
| 6 | 1 | flags | bit0=timestamp, bit1=change notify default |
| 7 | 1 | reserved | 0 |
| 8 | 4 | out_default | Initial output value (u32 LE) |
| 12 | 4 | out_polarity | Output polarity inversion mask (u32 LE) |
| 16 | 4 | in_polarity | Input polarity inversion mask (u32 LE) |
| 20 | 4 | reserved | 0 |

Validation rules (device rejects with `ERR BAD_MAP`):
- Output range `[out_base, out_base+out_count)` and input range
  `[in_base, in_base+in_count)` must not overlap.
- All pin numbers must be within GP0-GP22.

Errors: `ERR BAD_PARAM` (wrong hex length), `ERR BAD_MAP` (validation failed)

#### `map save`

Save the current RAM map to flash. Persists across power cycles.

```
> map save
OK
```

Errors: `ERR FLASH` (flash write failed)

#### `map default`

Reset to the default map (all 23 pins as inputs, pull-down).

```
> map default
OK
```

### Digital I/O

#### `read`

Read all input pin values.

```
> read
OK 0x000005
```

Response: hex value where bit N corresponds to input channel N.

#### `write <values> <mask>`

Set output pin values. Only bits set in the mask are modified.

```
> write 0x05 0x0F
OK
```

Arguments:
- `<values>` -- output bit pattern (u32, decimal or hex)
- `<mask>` -- which bits to modify (u32, decimal or hex)

Errors: `ERR NO_RESOURCE` (no output pins configured)

#### `state`

Get the complete I/O state (inputs, outputs, and flags).

```
> state
OK in=0x000005 out=0x00000A flags=0x00
```

Response fields:
- `in=0x<hex>` -- current input values
- `out=0x<hex>` -- current output values
- `flags=0x<hex>` -- status flags (bit 0: timestamp ring overflow)

### Input Change Subscription

#### `subscribe <on|off>`

Enable or disable asynchronous input change notifications.

```
> subscribe on
OK
> subscribe off
OK
```

When enabled, the device sends a push event on every input change:
```
! INPUT 0x000005 t=1234567890
```

### Pattern Playback

#### `pattern load <hex>`

Load an output pattern into the device buffer.

```
> pattern load 04000F00000064000000000000006400000005000000C800000000000000C8000000
OK accepted=4
```

Arguments:
- `<hex>` -- hex-encoded pattern data: a step count (u16 LE) followed by
  the steps. Each step is 8 bytes: `out_bits` (u32 LE) + `hold_ticks`
  (u32 LE, microseconds).

Response: `accepted=<n>` -- number of steps accepted.

Errors: `ERR TOO_LONG` (exceeds max pattern steps), `ERR BUSY` (pattern running)

#### `pattern run <mode> <repeat>`

Start pattern playback.

```
> pattern run once 1
OK
> pattern run loop 10
OK
```

Arguments:
- `<mode>` -- `once` (play through once) or `loop` (repeat)
- `<repeat>` -- repeat count (u16, >= 1; for `once` mode, use 1).
  `loop` with `repeat=0` is rejected with `ERR BAD_PARAM` -- there is
  no infinite mode; use a large repeat count and `pattern stop`.

Errors: `ERR BUSY` (already running), `ERR BAD_PARAM` (no pattern
loaded, or `loop` with repeat=0)

#### `pattern stop`

Stop pattern playback immediately.

```
> pattern stop
OK
```

#### `pattern status`

Get current pattern playback status.

```
> pattern status
OK state=running step=5 loops=3
```

Response fields:
- `state=<idle|loaded|running|done>` -- playback state (`loaded` =
  pattern data present but not started)
- `step=<n>` -- current step index
- `loops=<n>` -- completed loop count

When playback completes, a push event is sent:
```
! PATTERN_DONE loops=10
```

### Timestamp

#### `ts arm <mask> <mode>`

Arm timestamp capture for specified input channels and edge types.

```
> ts arm 0x07FF rising
OK
> ts arm 0x07FF both
OK
```

Arguments:
- `<mask>` -- bitmask of input channels to monitor (u32, hex or decimal)
- `<mode>` -- `rising`, `falling`, or `both`

Errors: `ERR BUSY` (already armed), `ERR NO_RESOURCE` (no input pins)

#### `ts get <max>`

Retrieve captured timestamp events. Returns a multi-line response.

```
> ts get 256
OK count=2
  0x00000005 c=1000 p=7 s=1
  0x0000000A c=2000 p=12 s=0
```

Arguments:
- `<max>` -- maximum number of events to retrieve (u16)

Response:
- First line: `OK count=<n>` where N is the actual event count.
- Following N lines, each with:
  - `0x<hex>` -- input snapshot at the moment of the edge
  - `c=<n>` -- raw microsecond count (u32)
  - `p=<n>` -- raw sub-microsecond phase (0-24, each step = 40ns)
  - `s=<0|1>` -- sync active flag (1 = sync clock running, 0 = free-running timer)

**Important**: When `count=0`, no data lines follow. The host must read
exactly N lines after the `OK count=N` line.

Errors: `ERR NOT_ARMED` (timestamp not armed)

#### `ts disarm`

Disarm timestamp capture and discard buffered events.

```
> ts disarm
OK
```

### Multi-Device Clock Synchronization

The sync subsystem allows multiple Pochi-DIO devices to share a common
clock via GP28, achieving zero-drift cross-device timestamps.

#### `sync arm`

Prepare as a **slave** device to receive the sync clock.

```
> sync arm
OK
```

The device configures GP28 as input and waits for the master's sync pulse.
Times out after 5 seconds if no sync pulse arrives.

Errors: `ERR SYNC_STATE` (not in Idle state)

#### `sync master`

Prepare as the **master** device to output the sync clock.

```
> sync master
OK
```

Errors: `ERR SYNC_STATE` (not in Idle state)

#### `sync start`

Start the sync pulse and 1MHz clock output (master only).

```
> sync start
OK
```

The master outputs a 3-pulse preamble (5us each) followed by a sync edge
at 30us, then transitions to continuous 1MHz clock. All devices (master
and slaves) reset their counters to zero at the sync edge and begin
counting clock edges.

Errors: `ERR SYNC_STATE` (not in MasterArmed state)

#### `sync stop`

Stop the sync clock output (master only).

```
> sync stop
OK
```

Errors: `ERR SYNC_STATE` (not in Clocking state)

#### `sync count`

Read the current sync clock count.

```
> sync count
OK count=1000000
```

Response: `count=<n>` -- number of clock edges since sync start (u64,
microsecond granularity). All devices sharing the same sync bus will
return identical values (zero drift).

Errors: `ERR SYNC_STATE` (not in Clocking state)

#### `sync disarm`

Release sync state and return to idle. Safe to call in any state.

```
> sync disarm
OK
```

Always returns `OK`, even if already idle.

#### `help`

Display a summary of available commands (text mode only, no binary
equivalent).

```
> help
Commands:
  version              Get firmware version
  caps                 Get device capabilities
  info                 Get device info (UID, device number)
  devnum <n>           Set device number (0-254, 255=unassigned)
  map get|set|save|default  Pin map operations
  read                 Read all inputs
  write <val> <mask>   Set outputs
  state                Get full I/O state
  pattern load|run|stop|status  Pattern operations
  ts arm|disarm|get    Timestamp operations
  subscribe on|off     Input change notifications
  sync arm|master|start|stop|count|disarm  Multi-device sync
  help                 Show this help
```

## 5. Complete Command Summary

| Command | Arguments | Response | Description |
|---|---|---|---|
| `version` | -- | `OK v<M>.<m>.<p> proto=<n>` | FW version |
| `caps` | -- | `OK dio=... out=... in=... ...` | Device capabilities |
| `info` | -- | `OK uid=<hex> devnum=<n>` | Device identification |
| `devnum <n>` | u8 (0-255) | `OK` | Set device number |
| `map get` | -- | `OK v=... out=... in=... ...` | Get pin map |
| `map set <hex>` | 48 hex chars | `OK` | Set pin map |
| `map save` | -- | `OK` | Save map to flash |
| `map default` | -- | `OK` | Reset to default map |
| `read` | -- | `OK 0x<hex>` | Read inputs |
| `write <v> <m>` | u32 u32 | `OK` | Set outputs |
| `state` | -- | `OK in=... out=... flags=...` | Full I/O state |
| `subscribe <on\|off>` | on/off | `OK` | Toggle change notifications |
| `pattern load <hex>` | hex data | `OK accepted=<n>` | Load pattern |
| `pattern run <m> <r>` | once\|loop, u16 | `OK` | Start playback |
| `pattern stop` | -- | `OK` | Stop playback |
| `pattern status` | -- | `OK state=... step=... loops=...` | Playback status |
| `ts arm <m> <mode>` | u32, rising\|falling\|both | `OK` | Arm timestamp |
| `ts get <max>` | u16 | `OK count=<n>` + N lines | Get timestamps |
| `ts disarm` | -- | `OK` | Disarm timestamp |
| `sync arm` | -- | `OK` | Prepare as slave |
| `sync master` | -- | `OK` | Prepare as master |
| `sync start` | -- | `OK` | Start sync clock |
| `sync stop` | -- | `OK` | Stop sync clock |
| `sync count` | -- | `OK count=<n>` | Read clock count |
| `sync disarm` | -- | `OK` | Release sync state |
| `help` | -- | (multi-line text) | Command help |

## 6. Error Codes

### Device Error Codes

These errors correspond to firmware status codes and indicate a problem
with the command or device state.

| Error Name | Code | Description |
|---|---|---|
| `BAD_CMD` | 0x01 | Unknown command ID (binary mode only) |
| `BAD_PARAM` | 0x02 | Invalid parameter value or format |
| `BAD_MAP` | 0x03 | Pin map validation failed (overlap, out of range) |
| `BUSY` | 0x04 | Device is busy (e.g., pattern already running) |
| `FLASH` | 0x05 | Flash read/write operation failed |
| `TOO_LONG` | 0x06 | Payload exceeds maximum length |
| `NOT_ARMED` | 0x07 | Timestamp not armed (ts get without ts arm) |
| `SYNC_STATE` | 0x08 | Invalid sync state transition |
| `SYNC_TIMEOUT` | 0x09 | Sync pulse not detected within timeout |
| `NO_RESOURCE` | 0x0A | Required resource not configured (e.g., no output pins for write) |

### Text Parser Error Codes

These errors are specific to the text command parser.

| Error Name | Description |
|---|---|
| `UNKNOWN_CMD` | Unrecognized command name |
| `LINE_TOO_LONG` | Input line exceeds 128-byte limit |

## 7. Push Events

Push events are asynchronous messages from the device, prefixed with `!`.
They can arrive at any time when the corresponding feature is active.

### `! INPUT`

Sent when an input pin changes (requires `subscribe on`).

```
! INPUT 0x000005 t=1234567890
```

Fields:
- `0x<hex>` -- current input pin values
- `t=<n>` -- timestamp of the change (microseconds)

### `! PATTERN_DONE`

Sent when pattern playback completes.

```
! PATTERN_DONE loops=10
```

Fields:
- `loops=<n>` -- total loops completed

### `! SYNC_DONE`

Sent on sync state transitions.

```
! SYNC_DONE status=ready devnum=1 ts=12345
```

Fields:
- `status=<state>` -- sync state description
- `devnum=<n>` -- device number
- `ts=<n>` -- timestamp

## 8. Timestamp Format (Phase 9.6)

Phase 9.6 changed the timestamp format from pre-computed nanoseconds to
raw counter values. The device sends raw data; the host computes
nanosecond timestamps.

### Raw Event Format

Each timestamp event line (from `ts get`) contains:

```
0x<inputs> c=<raw_count> p=<raw_phase> s=<sync_active>
```

| Field | Type | Description |
|---|---|---|
| `inputs` | u32 (hex) | Input pin snapshot at the edge |
| `c` (raw_count) | u32 | Microsecond counter value |
| `p` (raw_phase) | u8 (0-24) | Sub-microsecond phase (40ns per step) |
| `s` (sync_active) | 0 or 1 | 1 = sync clock running, 0 = free-running timer |

### Nanosecond Calculation

```
timestamp_ns = raw_count * 1000 + raw_phase * 40
```

This formula applies regardless of `sync_active`. When `s=0` (free-running
timer), `raw_phase` is always 0, so `timestamp_ns = raw_count * 1000`.

### 32-bit Count Extension

`raw_count` is a 32-bit value that wraps after approximately 71.6 minutes.
The host must track wrap-arounds and extend to 64 bits:

```
if raw_count < previous_raw_count:
    high_bits += 1
extended_count = (high_bits << 32) | raw_count
```

Maintain a separate counter per device per source (sync vs. free-running).

### Reconcile (Straddle Correction)

The device captures three DMA channels (input snapshot, count, phase)
simultaneously via a shared DREQ trigger. However, the bus arbiter
introduces a few tens of nanoseconds of skew between channels. When a
capture straddles a microsecond boundary, `count` and `phase` may be
inconsistent (approximately 8% of events).

**Reconcile algorithm:**

1. For each event, generate 3 candidate timestamps:
   - `as-is`: `count * 1000 + phase * 40`
   - `count-1`: `(count - 1) * 1000 + phase * 40`
   - `count+1`: `(count + 1) * 1000 + phase * 40`

2. Given K events from the same physical time (across channels or devices),
   enumerate all 3^K combinations and select the combination that minimizes
   the total pairwise absolute difference.

3. For K <= 8, exhaustive search (3^8 = 6,561 combinations). For K >= 9,
   prune candidates where adjacent differences exceed 1500ns.

**Grouping events for reconcile:**

Events are grouped by `raw_count` proximity:
- Events with `raw_count` values within +/-1 of each other belong to the
  same group.
- Events with `raw_count` gap >= 2 are in separate groups.
- Single events (K=1) cannot be corrected and use the as-is calculation.
- All events in a group must have the same `sync_active` value.
- Cross-device reconcile requires `sync_active=1` (shared clock). Events
  with `sync_active=0` from different devices use independent timers and
  cannot be compared.

**Achieved precision:**
- Same device, multiple channels: ~40ns (DMA arbiter jitter only)
- Cross-device, same channel: <= 500ns (verified with 500+ events)
- Cross-device, multiple channels: <= 500ns

## 9. Device Discovery

### Enumeration Procedure

1. List all serial ports on the system.
2. Filter by USB properties:
   - VID = `0x2E8A`
   - PID = `0x000A`
   - Product string starts with `"Pochi"` (also accept legacy `"Tachyon"`)
3. For each matching port, open it and send `info\r\n`.
4. Parse the response to extract `uid` and `devnum`.
5. Optionally send `version\r\n` to get the firmware version.

### Device Selection

When multiple devices are connected, the host selects one by:

| Selector | Method |
|---|---|
| Port path | Open the specified OS serial port directly |
| UID | Match against the USB serial number descriptor (no command needed) |
| Device number | Send `info` to all devices and match `devnum` |
| (none) | If exactly one device is found, use it. If multiple, report an error |

### Device Number Conflicts

Device numbers are user-assigned and can conflict. The host should:

1. Detect duplicates during enumeration.
2. Warn the user about conflicts.
3. Fall back to UID or port path for unambiguous selection.

## 10. Pin Map

### Binary Format

The pin map is a 24-byte structure sent as a 48-character hex string.
See the `map set` command documentation in Section 4 for the full
byte layout.

### TOML Format

Host-side tools can use TOML files for human-readable map configuration.
The host converts TOML to the 24-byte binary format before sending to
the device.

```toml
# Example: 12 outputs (GP0-GP11) + 11 inputs (GP12-GP22)
version = 1

[output]
base  = 0
count = 12
default = 0x000
polarity = 0x000

[input]
base  = 12
count = 11
pull  = "up"        # "up" | "down" | "none"
timestamp = true
```

```toml
# Default map: all 23 pins as inputs
version = 1

[input]
base  = 0
count = 23
pull  = "down"
timestamp = true
```

### Validation Rules

- Output range `[out_base, out_base+out_count)` and input range
  `[in_base, in_base+in_count)` must not overlap.
- All pins must be within GP0-GP22 (max 23 pins).
- Either output or input count can be zero (single-direction operation).
- The default map (all inputs) is applied on power-up if no map is saved
  to flash.

## 11. Pattern

### Step Format

Each pattern step is 8 bytes:

| Offset | Size | Field | Description |
|---|---|---|---|
| 0 | 4 | out_bits | Output bit pattern (u32 LE, bit0 = first output channel) |
| 4 | 4 | hold_ticks | Hold duration in microseconds (u32 LE) |

### Hex Encoding

The `pattern load` payload is a step count (u16 LE) followed by the
concatenated steps, hex-encoded.
Example: 4 steps = 2 + 4 x 8 bytes = 34 bytes = 68 hex characters.

### TOML Format

Host-side tools can use TOML files for human-readable pattern definition.
The host converts TOML to hex before sending. Either a `steps` list or an
`edge` list (expanded to steps host-side) is accepted.

```toml
# Example pattern: toggle outputs with timing
version = 1
unit = "us"
steps = [
  { out = 0x0F, hold = 100 },
  { out = 0x00, hold = 100 },
  { out = 0x05, hold = 200 },
  { out = 0x00, hold = 200 },
]
```

```toml
# Equivalent edge-list form: per-channel transitions at absolute times
[[edge]]
ch = 0
t = 0
level = 1

[[edge]]
ch = 0
t = 100
level = 0
```

### Playback Modes

- **Once**: Play through the pattern once and stop. `pattern run once 1`
- **Loop**: Repeat the pattern N times (N >= 1). `pattern run loop <N>`
  (N=0 is rejected with `ERR BAD_PARAM`; for long runs use a large N
  and stop with `pattern stop`)

### Maximum Steps

The device has a fixed-size pattern buffer. The maximum step count is
reported by `caps` (typically 256). `pattern load` returns the number of
accepted steps. Exceeding the limit returns `ERR TOO_LONG`.

## 12. Multi-Device Sync Protocol

### Overview

Multiple Pochi-DIO devices can share a common time base by connecting all
GP28 pins together on a single bus. One device acts as master (outputs the
sync clock), and all others act as slaves (count the clock edges).

### Sync Procedure

```
Phase 1 -- Prepare
  Host -> Slave1: sync arm     (GP28 = input, wait for sync pulse)
  Host -> Slave2: sync arm
  Host -> Master: sync master  (GP28 = output, ready to transmit)

Phase 2 -- Start
  Host -> Master: sync start   (output sync pulse + 1MHz clock)
  (All devices reset counters at the sync edge, then count 1MHz edges)

Phase 3 -- Operate
  Host -> any device: sync count  (returns identical clock count)
  (Timestamp capture works as normal, with sync_active=1)

Phase 4 -- Stop
  Host -> Master: sync stop    (stop clock output)
  Host -> Slave1: sync disarm  (return to idle)
  Host -> Slave2: sync disarm
  Host -> Master: sync disarm
```

### Sync Pulse Waveform

The master outputs a 3-pulse preamble to distinguish the sync signal from
noise. Each preamble pulse is 5us wide (10x wider than the 500ns 1MHz
clock pulses). The 4th rising edge at 30us is the sync point where all
devices reset their counters to zero.

```
  Idle (Low)
  ─────┐
       │  P1      P2      P3      SYNC EDGE      1MHz Clock
       └──┐  ┌────┐  ┌────┐  ┌────────────┐ ┌─┐ ┌─┐ ┌─┐ ...
          └──┘    └──┘    └──┘             └─┘ └─┘ └─┘ └─┘ └...
          5us 5us 5us 5us 5us 5us  10us      500ns H/L = 1MHz
                                    ^
                               Zero point
                               (all counters reset)
```

### State Transitions

```
Idle ──[sync arm]──> Armed ──[sync pulse detected]──> Clocking
Idle ──[sync master]──> MasterArmed ──[sync start]──> Clocking
Armed ──[timeout 5s]──> Idle
Clocking ──[sync stop (master)]──> Idle
Any state ──[sync disarm]──> Idle
```

### Precision

- **Drift**: Zero. All devices count edges from the same physical clock.
- **Cross-device accuracy**: <= 500ns after host-side reconcile (verified
  with 500+ events in hardware testing).
- **Residual jitter** (~480ns max): Caused by PIO sampling phase
  differences between devices. Cannot be eliminated by reconcile alone;
  addressable with external clock synchronization in future hardware
  revisions.
