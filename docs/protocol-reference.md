# Pochi-DIO CDC Text Protocol Reference (proto=2)

Self-contained reference for the v2 CDC text command protocol used to
communicate with Pochi-DIO devices. It covers everything SDK developers need
to implement a host-side driver.

This document describes protocol version **2** only. There is no other
version, no compatibility mode and no fallback: a host accepts `proto=2` and
nothing else.

The firmware is the source of truth. Every request/response example below is
quoted from the golden transcripts in `protocol/golden/` (`*.txt`), which are
replayed against the firmware and against every host implementation. When this
document and a golden transcript disagree, the transcript wins and this
document is wrong.

Notation used in examples (the golden notation):

| Prefix | Meaning |
|---|---|
| `> ` | request line sent by the host (terminated with CR/LF on the wire) |
| `< ` | response line, or an asynchronous event when followed by `! ` |
| `<   ` | continuation line of a counted response (`< ` plus the 2-space wire line) |

## 1. Overview

Pochi-DIO exposes a USB CDC-ACM (virtual serial port) interface. The host
sends text commands over this serial port and receives text responses. No
binary framing, COBS encoding, or CRC computation is used by the host. The
text protocol is the only host API for the CLI, every SDK, the GUI and the
VS Code extension. A host never sends binary frames to a CDC port, and never
mixes text and binary within one connection.

**Protocol summary:**

- Send: `<cmd> [<sub>] [<args>...]` terminated by CR, LF or CRLF
- Receive exactly one response per request:
  - single line: `OK[ <key>=<value>...]` or `ERR <NAME>`
  - counted multi-line: a header containing `count=<N>` followed by exactly N
    continuation lines
- Receive asynchronous push events: `! <EVENT> <key>=<value>...`

## 2. Connection

### USB Identification

| Property | Value |
|---|---|
| VID | `0x2E8A` (Raspberry Pi) |
| PID | `0x000A` |
| Product string | Starts with `"Pochi"` (checked when the OS provides it) |
| Serial number | 16-character hex string derived from the RP2350 chip UID |

VID and PID must match, and, when the operating system provides a product
string, it must start with `Pochi`. No other product name is accepted.

### Opening the Port

Baud rate is irrelevant for CDC virtual serial ports (USB full-speed bulk
transfer). Any baud rate value will work. The host must:

1. Enumerate serial ports and filter by VID/PID/product string.
2. Open the matching port with any baud rate (115200 by convention) and
   **assert DTR**. The device sends no events while DTR is deasserted.
3. Send `version` and require `proto=2`. Any other value fails the connection
   with an explicit "unsupported protocol" error. This is the final check;
   the USB filter alone never proves a device is usable.
4. Set a read timeout (recommended: 1000 ms for commands, longer for
   event-driven operations).

On DTR falling the device switches `subscribe` off and returns to text mode.

### Line Ending and Length

All requests and responses use CR/LF. The device accepts `\r`, `\n` or `\r\n`
as input line endings; responses end with `\r\n`. Empty lines are ignored.

A line is at most **256 bytes**, not counting the terminator. A longer line is
discarded up to and including its terminator and answered with exactly one
`ERR LINE_TOO_LONG`; the discarded tail is never executed as a command.

```
> pattern add 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1 0x0:1
< ERR LINE_TOO_LONG
```

(That request is 257 bytes. A 256-byte line is accepted.)

### Command Syntax

```
<command> [<subcommand>] [<arg1> <arg2> ...]
```

- Command names, subcommands and keyword arguments are **case-insensitive**.
- Arguments are separated by spaces or tabs.
- Numeric arguments accept decimal (`255`) or hex with `0x` prefix (`0xFF`).
  Responses always use the canonical format described in section 3.
- Trailing tokens on a command that takes no arguments are rejected with
  `ERR BAD_PARAM`; the command is not executed.

```
> VERSION
< OK fw=0.1.3 proto=2
> version extra
< ERR BAD_PARAM
> reset now
< ERR BAD_PARAM
```

## 3. Response Format

### Single-line responses

```
OK[ <key>=<value>...]
ERR <NAME>
```

Some commands return a bare `OK`. Others return key-value data after `OK`.
Only the keys listed in this document are ever sent.

### Value formats

| Kind | Format | Example |
|---|---|---|
| Masks and bit values | `0x` + 8 lower-case hex digits | `0x0c7fffff` |
| `map` flags | `0x` + 2 lower-case hex digits | `0x00` |
| Feature bits | `0x` + 8 lower-case hex digits | `0x00000003` |
| Counts, quantities, times | unitless decimal; the unit is part of the key name (`ts_res_ns`, `tick_ns`, `t=` in microseconds) | `total=2` |

### Counted multi-line responses

A response whose header contains `count=<N>` is followed by **exactly N**
continuation lines, each starting with two spaces. `count=` is reserved for
this form: no single-line response uses it. A multi-line response without a
`count=` header does not exist. With `count=0`, no continuation line follows.

Two commands answer in this form: `ts get` and `help`.

```
> ts arm 0x1 both
< OK
> ts get 85
< OK count=0 overflow=0
> ping 5
< OK pong=5
```

`sync count` is **not** a counted response: it is the single line
`OK clocks=<n>`.

### Error Response

```
ERR <NAME>
```

The error names are listed in section 6.

### Push Events

```
! <EVENT> <key>=<value>...
```

Events are sent asynchronously and never inside a response, including the
continuation lines of a counted response. See section 7.

### Re-synchronisation

One command produces exactly one response. A host that times out, reads an
unexpected line or receives a short counted response is out of step and must
resynchronise before the next command: send `ping <random u32>` and discard
every response line until `OK pong=<same value>` arrives (events go to the
event path). If this fails the connection is closed. A host never silently
drains input to "catch up".

## 4. Command Reference

### Device Information

#### `version`

```
> version
< OK fw=0.1.3 proto=2
```

Response fields:
- `fw=<major>.<minor>.<patch>` -- firmware version
- `proto=<n>` -- protocol version. Always `2`.

#### `caps`

```
> caps
< OK dio=25 out=0 in=25 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x00000003
```

Response fields:
- `dio=<n>` -- number of DIO channels (always 25: ch0-ch24, see section 10)
- `out=<n>` -- number of output channels in the active pin map
- `in=<n>` -- number of input channels in the active pin map
- `ts_res_ns=<n>` -- timestamp phase resolution in nanoseconds (40)
- `tick_ns=<n>` -- pattern tick length in nanoseconds (200)
- `pattern=<n>` -- maximum number of pattern steps
- `ring=<n>` -- timestamp ring buffer capacity (events)
- `feat=0x<hex>` -- feature bits:
  - bit 0 (`FEAT_SYNC = 0x1`) -- multi-device clock sync
  - bit 1 (`FEAT_RESET = 0x2`) -- reset commands

`out` and `in` follow the direction mask:

```
> map set flags=0x00 dir=0x00000003 pu=0x00000000 pd=0x0c7ffffc def=0x00000000 opol=0x00000000 ipol=0x00000000 edge=0x0c7ffffc
< OK
> caps
< OK dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x00000003
```

#### `info`

```
> info
< OK uid=0000000000000000 devnum=255
```

Response fields:
- `uid=<hex>` -- 16-character hex string, hardware-unique chip identifier
  (the example is the simulator's fixed value)
- `devnum=<n>` -- user-assigned device number (0-254), or `255` if unassigned

#### `devnum <n>`

Set the device number. It is written to flash immediately and survives reset.

```
> devnum 7
< OK
> info
< OK uid=0000000000000000 devnum=7
> devnum 255
< OK
```

Arguments: `<n>` -- 0-254 = valid, 255 = unassign.

Errors: `ERR BAD_PARAM` (value out of range, not a number, missing or extra
argument; the number is left unchanged), `ERR FLASH` (flash write failed; the
previous number stays in place).

#### `ping <u32>`

Echo a number. Hosts use it only to resynchronise (section 3).

```
> ping 12345
< OK pong=12345
> ping 0xFFFFFFFF
< OK pong=4294967295
> ping 4294967296
< ERR BAD_PARAM
```

### Pin Map

The pin map is described by eight values (section 10 explains the bit
convention and the validity rules). Masks are **physical GP bit positions**.

#### `map get`

```
> map get
< OK v=2 flags=0x00 dir=0x00000000 pu=0x00000000 pd=0x0c7fffff def=0x00000000 opol=0x00000000 ipol=0x00000000 edge=0x0c7fffff
```

Response fields: `v=2` followed by the eight map keys of the table below.
Everything after `OK ` can be pasted back into `map set` and yields the same
map (round trip).

#### `map set [v=2] <key>=<value> ...`

Set the pin map. **All eight keys are required**, in any order, each exactly
once; a leading `v=2` is optional. Values are decimal or hex; zero padding is
not needed.

```
> map set flags=0x00 dir=0x0000000f pu=0x000000f0 pd=0x0c7fff00 def=0x00000005 opol=0x00000008 ipol=0x00000100 edge=0x0c7ffff0
< OK
> map get
< OK v=2 flags=0x00 dir=0x0000000f pu=0x000000f0 pd=0x0c7fff00 def=0x00000005 opol=0x00000008 ipol=0x00000100 edge=0x0c7ffff0
```

| Key | Field | Constraint |
|---|---|---|
| `flags` | flags (u8) | reserved, all bits must be 0 |
| `dir` | direction mask | subset of `VALID_DIO_MASK`; 1 = output |
| `pu` | pull-up mask | subset of `VALID & ~dir`; `pu & pd == 0` |
| `pd` | pull-down mask | subset of `VALID & ~dir` |
| `def` | output default | subset of `dir` |
| `opol` | output polarity (1 = inverted) | subset of `dir` |
| `ipol` | input polarity (1 = inverted) | subset of `VALID & ~dir` |
| `edge` | input-change event mask | subset of `VALID & ~dir` |

Errors:
- `ERR BAD_MAP` -- a constraint above is violated (one transcript per rule):
  ```
  > map set flags=0x01 dir=0x00000000 pu=0x00000000 pd=0x00000000 def=0x00000000 opol=0x00000000 ipol=0x00000000 edge=0x00000000
  < ERR BAD_MAP
  ```
- `ERR BAD_PARAM` -- missing, duplicate or unknown key, `v=` other than 2, a
  value that is not a number or does not fit in u32, no arguments, or any
  other form (including a bare hex string and a single `dir=` key):
  ```
  > map set dir=0x00000003
  < ERR BAD_PARAM
  > map set v=3 flags=0x00 dir=0x0000000f pu=0x000000f0 pd=0x0c7fff00 def=0x00000005 opol=0x00000008 ipol=0x00000100 edge=0x0c7ffff0
  < ERR BAD_PARAM
  ```
- `ERR BUSY` -- a pattern is running.

A failed `map set` changes nothing. A successful `map set` (and
`map default`) returns the pattern engine to idle, erasing the loaded steps,
and disarms the timestamp recorder.

```
> map set flags=0x00 dir=0x00000003 pu=0x00000000 pd=0x0c7ffffc def=0x00000000 opol=0x00000000 ipol=0x00000000 edge=0x0c7ffffc
< OK
> pattern add 0x1:5 0x0:10
< OK total=2
> pattern status
< OK state=loaded step=0 loops=0 total=2
> map set flags=0x00 dir=0x0000000f pu=0x00000000 pd=0x0c7ffff0 def=0x00000005 opol=0x00000000 ipol=0x00000000 edge=0x0c7ffff0
< OK
> pattern status
< OK state=idle step=0 loops=0 total=0
```

#### `map save`

Save the current RAM map to flash. It is applied again after every reset.

```
> map save
< OK
```

Errors: `ERR FLASH` (flash write failed).

#### `map default`

Reset the RAM map to the default map (section 10). The saved map in flash is
untouched, so it returns after `reset`; run `map save` after `map default` to
erase it. Refused with `ERR BUSY` while a pattern is running.

```
> map default
< OK
```

### Digital I/O

All bit values are physical GP bits, as logical levels (input polarity applied
on read, output polarity applied by the device when driving the pins).

#### `read`

Read the input pins.

With the input pins GP4-GP7 driven high externally:

```
> read
< OK in=0x000000f0
```

Response: `in=0x<hex>` -- logical input levels. Output pins and bits that are
not DIO pins are always 0.

Errors: `ERR NO_RESOURCE` (no input pins configured).

#### `write <values> <mask>`

Set output pin values. Only bits in `<mask>` change; value bits outside the
mask are ignored.

```
> write 0x2 0x3
< OK
> state
< OK in=0x00000000 out=0x00000006
```

Arguments:
- `<values>` -- output bit pattern (u32, decimal or hex)
- `<mask>` -- which bits to modify (u32). Must be a subset of the output pins.

Errors: `ERR NO_RESOURCE` (no output pins configured; takes precedence),
`ERR BAD_PARAM` (mask covers a pin that is not an output, or a bit that is not
a DIO pin; malformed arguments).

```
> write 0x10 0x10
< ERR BAD_PARAM
```

#### `state`

Get the inputs and the output latch.

```
> state
< OK in=0x00000030 out=0x00000005
```

Response fields:
- `in=0x<hex>` -- logical input levels
- `out=0x<hex>` -- logical output latch (the value last written or output by a
  pattern). With `opol` set, the physical pin level is `out ^ opol`.

### Input Change Subscription

#### `subscribe <on|off>`

Enable or disable asynchronous input-change events (section 7). Repeating
either form is accepted.

```
> subscribe on
< OK
> subscribe off
< OK
```

Errors: `ERR NO_RESOURCE` (`on` with no input pins configured; `off` is
always accepted), `ERR BAD_PARAM`.

Subscription is owned by the SDK, not by applications: it sends `subscribe on`
when the first event subscriber attaches and `subscribe off` when the last one
leaves. `subscribe` is rejected on the SDK's raw-command path.
A reset or DTR drop turns it off.

### Pattern Playback

A pattern is a list of steps `<out_bits>:<hold_ticks>`. Patterns are
transferred by appending; there is no "load a whole pattern" command.

#### `pattern add <step>...`

Append steps to the pattern buffer.

```
> pattern add 0x1:5 0x0:10
< OK total=2
> pattern add 0x2:1
< OK total=3
```

Step syntax: `<out_bits>:<hold_ticks>`, decimal or hex on both sides.

- `out_bits` -- **logical** output levels (physical GP bits), a subset of the
  direction mask. `0` is valid (all low). The device XORs `opol` when driving
  the pins, exactly as for `write`.
- `hold_ticks` -- u32, at least 1. One tick is 200 ns (`caps.tick_ns`).

Rules:
- Each call is **atomic**: either all its steps are appended or none.
- Accepted while idle, loaded or done (a done pattern becomes loaded again,
  keeping its steps and appending the new ones, and the pass counter is
  cleared). `ERR BUSY` while running.
- The total may not exceed `caps.pattern` (256). A call that would cross the
  limit is refused as a whole with `ERR TOO_LONG`.
- Clear the buffer with `pattern reset`.
- A host splits a long pattern into several calls, packing as many steps as
  fit in one 256-byte line.

```
> pattern add 0x1:5 0x4:5 0x2:5
< ERR BAD_PARAM
> pattern add 0x1:0
< ERR BAD_PARAM
```

Errors: `ERR BAD_PARAM` (step on a non-output pin, `hold_ticks` 0 or beyond u32,
malformed step, no steps), `ERR BUSY`, `ERR TOO_LONG`.

#### `pattern run once [<repeat>]` / `pattern run loop <repeat>`

Start playback.

```
> pattern run once
< OK
> pattern run loop 3
< OK
```

Arguments:
- `once` plays the steps exactly once. An optional `<repeat>` is accepted and
  ignored.
- `loop <repeat>` repeats the steps `repeat` times (u16, 1-65535). There is no
  infinite mode; use a large count and `pattern stop`.

Errors: `ERR BUSY` (already running), `ERR BAD_PARAM` (nothing loaded; `loop`
without a count, with 0 or above 65535; unknown mode).

```
> pattern run loop 65536
< ERR BAD_PARAM
> pattern run loop 0
< ERR BAD_PARAM
```

#### `pattern stop`

Stop playback. The steps stay loaded and no event is sent. The output latch
keeps the value of the step that was last output.

```
> pattern stop
< OK
> pattern stop
< ERR NOT_RUNNING
```

Errors: `ERR NOT_RUNNING` when the engine is idle, loaded or done.

#### `pattern reset`

Abort any run, clear the loaded steps and return to idle. USB stays up. No
event is sent.

```
> pattern reset
< OK
> pattern status
< OK state=idle step=0 loops=0 total=0
```

#### `pattern status`

```
> pattern status
< OK state=running step=1 loops=0 total=2
```

Response fields:
- `state=<idle|loaded|running|done>` -- `loaded` means steps are present but
  not started
- `step=<n>` -- the step currently being output while running; 0 otherwise
- `loops=<n>` -- completed passes
- `total=<n>` -- number of steps in the buffer

#### Timing

One step takes `hold_ticks x 200 ns + 133 ns` (the PIO needs two extra
instructions per step). Three one-tick steps therefore last 999 ns, and a
single 1000-tick step 200133 ns. Hosts convert nanoseconds to ticks only when
the value is a multiple of 200 ns, and report an error otherwise: they never
round.

Completion is reported once with `! PATTERN_DONE` (section 7). A run that does
not finish within the firmware's safety budget (about twice the nominal
duration plus 100 ms) is forced to a safe state and reported with
`! PATTERN_TIMEOUT` instead, never both.

### Device Reset

#### `reset`

Reboot the device. It returns `OK`, then USB **re-enumerates**: the host must
close the port and rediscover the device. RAM state returns to defaults (default
map, idle pattern engine, timestamp disarmed, sync idle, `subscribe` off);
flash state (saved map, device number) survives.

```
> reset
< OK
> version
< OK fw=0.1.3 proto=2
```

(The second line is what the next connection sees after re-enumeration.)

#### `bootsel`

Reboot into BOOTSEL mass-storage mode for UF2 reflash. The device answers `OK`
and reappears as a USB drive; no further request reaches the firmware.

```
> bootsel
< OK
```

### Timestamp

Timestamps record edges of input pins into a ring of `caps.ring` events. The
recorded `in=` value is the **logical** level (input polarity applied) of the
armed pins; every other bit is 0. Rising and falling are logical edges.

#### `ts arm <mask> <rising|falling|both>`

```
> ts arm 0x1 rising
< OK
> ts status
< OK armed=1 pending=0 overflow=0
```

Arguments:
- `<mask>` -- input pins to monitor (u32, non-zero, subset of the input pins)
- `<mode>` -- `rising`, `falling` or `both`

Errors: `ERR BUSY` (already armed; the first arm stays), `ERR NO_RESOURCE` (no
input pins), `ERR BAD_PARAM` (empty mask, mask outside the DIO pins or on an
output pin, bad mode, missing or extra argument).

```
> ts arm 0x0 rising
< ERR BAD_PARAM
> ts arm 0x10000000 rising
< ERR BAD_PARAM
```

#### `ts get <max>`

Retrieve captured events (oldest first, removed from the ring). Counted
multi-line response.

```
> ts arm 0x1 both
< OK
> ts get 1
< OK count=1 overflow=0
<   in=0x00000001 c=1 p=0 s=0
```

Arguments: `<max>` -- 1 to 85. A single response is limited by the line buffer,
so draining a full ring takes several calls. Other values are `ERR BAD_PARAM`.

```
> ts get 0
< ERR BAD_PARAM
> ts get 86
< ERR BAD_PARAM
```

Response:
- Header: `OK count=<n> overflow=<0|1>`. `overflow=1` means the ring overwrote
  its oldest events since the last `ts get`; the flag is reported once and
  then cleared. An exactly full ring is not an overflow.
- N continuation lines `  in=0x<hex> c=<u32> p=<0-24> s=<0|1>`:
  - `in=` -- logical levels of the armed pins at the edge
  - `c=` -- raw count (section 8)
  - `p=` -- raw phase, 0-24 steps of `ts_res_ns`
  - `s=` -- 1 when the sync clock was running at the edge, 0 for the
    free-running timer

With `count=0` no continuation line follows. The host reads exactly N lines.

Errors: `ERR NOT_ARMED`.

#### `ts status`

```
> ts status
< OK armed=0 pending=0 overflow=0
```

Response fields: `armed=<0|1>`, `pending=<n>` (events in the ring),
`overflow=<0|1>`. `ts status` does not clear the overflow flag; the next
`ts get` reports it and clears it.

```
> ts status
< OK armed=1 pending=256 overflow=1
> ts get 5
< OK count=5 overflow=1
<   in=0x00000000 c=20 p=0 s=0
<   in=0x00000001 c=30 p=0 s=0
<   in=0x00000000 c=40 p=0 s=0
<   in=0x00000001 c=50 p=0 s=0
<   in=0x00000000 c=60 p=0 s=0
> ts status
< OK armed=1 pending=251 overflow=0
```

#### `ts disarm`

Disarm and discard buffered events. A no-op when not armed.

```
> ts disarm
< OK
```

### Multi-Device Clock Synchronization

The sync subsystem lets several Pochi-DIO devices share a clock over GP28,
giving zero-drift cross-device timestamps. State machine:

```
idle --sync arm--> slave-armed --sync edge--> clocking (slave)
idle --sync master--> master-armed --sync start--> clocking (master) --sync stop--> idle
sync disarm: any state -> idle (always OK)
```

Every other transition is refused with `ERR SYNC_STATE`.

```
> sync arm
< OK
> sync arm
< ERR SYNC_STATE
> sync disarm
< OK
```

- `sync arm` -- prepare as a slave (GP28 = input, wait for the sync pulse). A
  slave that sees no sync edge for 5 seconds silently returns to idle.
- `sync master` -- prepare as the master (GP28 = output).
- `sync start` -- master only, from master-armed: output the sync pulse and a
  1 MHz clock. All devices reset their counter at the sync edge.
- `sync stop` -- master only, from clocking: stop the clock and go idle. A
  slave leaves clocking with `sync disarm`.
- `sync disarm` -- return to idle from any state; always `OK`.
- `sync count` -- read the clock count; valid only while clocking.

```
> sync master
< OK
> sync start
< OK
> sync count
< OK clocks=0
> sync stop
< OK
> sync count
< ERR SYNC_STATE
```

Response of `sync count`: `OK clocks=<u64>` -- sync clock edges (microseconds)
since the sync edge, identical on every device on the bus. This is a single
line, not a counted response.

`reset` drops the sync state.

### `help`

Counted multi-line response, one line per command family. Text mode only.

```
> help
< OK count=16
<   version                                  Get firmware version
<   caps                                     Get device capabilities
<   info                                     Get device UID and number
<   devnum <n>                               Set device number (0-254, 255=clear)
<   ping <u32>                               Echo a number
<   map get|set|save|default                 Pin map operations
<   read                                     Read all inputs
<   write <val> <mask>                       Set outputs
<   state                                    Get inputs and outputs
<   pattern add|run|stop|reset|status        Output pattern operations
<   ts arm|disarm|get|status                 Timestamp operations
<   subscribe on|off                         Input change events
<   sync arm|master|start|stop|disarm|count  Multi-device clock sync
<   reset                                    Reboot the device
<   bootsel                                  Reboot into the USB bootloader
<   help                                     Show this help
```

## 5. Complete Command Summary

| Command | Arguments | Success response |
|---|---|---|
| `version` | -- | `OK fw=<maj>.<min>.<patch> proto=2` |
| `caps` | -- | `OK dio=25 out=<n> in=<n> ts_res_ns=40 tick_ns=200 pattern=<max_steps> ring=<n> feat=0x%08x` |
| `info` | -- | `OK uid=<16 hex> devnum=<0-255>` |
| `devnum <n>` | 0-254, 255 = clear | `OK` |
| `ping <u32>` | u32 | `OK pong=<u32>` |
| `map get` | -- | `OK v=2 flags=0x%02x dir=0x%08x pu=0x%08x pd=0x%08x def=0x%08x opol=0x%08x ipol=0x%08x edge=0x%08x` |
| `map set [v=2] <k=v ...>` | all 8 keys | `OK` |
| `map save` / `map default` | -- | `OK` |
| `read` | -- | `OK in=0x%08x` |
| `write <val> <mask>` | u32 u32 | `OK` |
| `state` | -- | `OK in=0x%08x out=0x%08x` |
| `pattern add <step>...` | `<out_bits>:<hold_ticks>` | `OK total=<n>` |
| `pattern run once [<repeat>]` / `pattern run loop <repeat>` | u16 | `OK` |
| `pattern stop` / `pattern reset` | -- | `OK` |
| `pattern status` | -- | `OK state=<idle\|loaded\|running\|done> step=<n> loops=<n> total=<n>` |
| `ts arm <mask> <rising\|falling\|both>` | u32 | `OK` |
| `ts disarm` | -- | `OK` |
| `ts get <max>` | 1-85 | `OK count=<N> overflow=<0\|1>` + N lines `  in=0x%08x c=<u32> p=<0-24> s=<0\|1>` |
| `ts status` | -- | `OK armed=<0\|1> pending=<n> overflow=<0\|1>` |
| `subscribe on\|off` | -- | `OK` |
| `sync arm\|master\|start\|stop\|disarm` | -- | `OK` |
| `sync count` | -- | `OK clocks=<u64>` |
| `reset` | -- | `OK`, then USB re-enumerates |
| `bootsel` | -- | `OK`, then USB re-enumerates as BOOTSEL |
| `help` | -- | `OK count=<N>` + N lines |

Only the forms in this table exist. An unknown subcommand answers
`ERR UNKNOWN_CMD`, and a malformed argument list `ERR BAD_PARAM`. In
particular, patterns are transferred only with `pattern add`, and `map set`
takes only `key=value` pairs; a hex blob is refused:

```
> pattern foo
< ERR UNKNOWN_CMD
> map set 010C0C0B02010000000000000000000000000000000000000000
< ERR BAD_PARAM
```

## 6. Error Codes

### Errors reachable over the text protocol

| Error name | Meaning |
|---|---|
| `BAD_PARAM` | Invalid, missing or extra argument, or a value out of range |
| `BAD_MAP` | Pin map validation failed (section 10) |
| `BUSY` | Operation refused in the current state (pattern running, timestamp already armed) |
| `FLASH` | Flash write failed |
| `TOO_LONG` | Payload exceeds its maximum (pattern buffer full) |
| `NOT_ARMED` | `ts get` while the recorder is not armed |
| `SYNC_STATE` | Sync command invalid in the current sync state |
| `NO_RESOURCE` | The pin group the command needs is not configured (no outputs / no inputs) |
| `NOT_RUNNING` | `pattern stop` while no pattern is running |
| `UNKNOWN_CMD` | Unrecognised command or subcommand |
| `LINE_TOO_LONG` | Line longer than 256 bytes |

### Errors that exist only on other transports

| Error name | Code | Where |
|---|---|---|
| `BAD_CMD` | 0x01 | binary frames: unknown command ID |
| `TRANSPORT_NOT_SUPPORTED` | 0x0B | HID: command not available on that transport |

A text host never sees these two. Status code 0x09 is reserved (no error is
defined for it). Binary status codes of the text errors: `BAD_PARAM` 0x02,
`BAD_MAP` 0x03, `BUSY` 0x04, `FLASH` 0x05, `TOO_LONG` 0x06, `NOT_ARMED` 0x07,
`SYNC_STATE` 0x08, `NO_RESOURCE` 0x0A, `NOT_RUNNING` 0x0C.

An unrecognised `ERR <NAME>` is itself an error for the host (nothing is
mapped silently to a default).

An error never leaves the device unusable; the next request is answered
normally:

```
> nonsense
< ERR UNKNOWN_CMD
> ping 1
< OK pong=1
```

## 7. Push Events

Push events are asynchronous lines prefixed with `! `. There are exactly three.

### `! INPUT`

Sent when an input pin selected by the map `edge` mask changes, while
`subscribe on` is active.

```
< ! INPUT in=0x00000001 t=5
```

Fields:
- `in=0x<hex>` -- logical levels of **all** input pins (input polarity
  applied), not only the edge pins
- `t=<n>` -- detection time in microseconds. The firmware polls the pins, so
  `t` is when the change was noticed, not a captured edge time.

An event is sent only when `((in ^ previous_in) & edge) != 0`. Output pins
never produce events, and an empty `edge` mask makes `subscribe` silent. The
default map has `edge` set on every DIO pin.

### `! PATTERN_DONE`

Sent once when a pattern run completes normally. Not sent after `pattern stop`
or `pattern reset`. Sent whether or not `subscribe` is on.

```
< ! PATTERN_DONE loops=1
```

`loops=<n>` -- passes completed.

### `! PATTERN_TIMEOUT`

Sent instead of `PATTERN_DONE` when the safety budget aborts a run (for
example a stalled PIO). The pattern engine goes to `done`, and the output
latch keeps the last step's logical value.

```
< ! PATTERN_TIMEOUT loops=0
```

`loops=<n>` -- passes completed before the timeout.

### Event delivery

- Events are never inserted into a response, including a counted response.
- Events are encoded in the form of the most recently completed CDC input;
  after boot or reset that form is text.
- While DTR is deasserted the device drops events immediately. When DTR
  falls, `subscribe` is turned off and the device returns to text mode.
- Hosts discard an unrecognised event with an error log entry and do not put
  it in the response queue.

## 8. Timestamp Format

The device sends raw counter values; the host computes nanoseconds.

### Raw Event Format

Each continuation line of `ts get`:

```
  in=0x<inputs> c=<raw_count> p=<raw_phase> s=<sync_active>
```

| Field | Type | Description |
|---|---|---|
| `in` | u32 (hex) | logical levels of the armed pins; other bits 0 |
| `c` (raw_count) | u32 | sync-clock count when `s=1`; the free-running microsecond timer when `s=0` |
| `p` (raw_phase) | 0-24 | sub-microsecond phase in steps of `ts_res_ns` (0 when `s=0`) |
| `s` (sync_active) | 0 or 1 | 1 while the sync clock is running |

### Nanosecond Calculation

```
timestamp_ns = raw_count * 1000 + raw_phase * ts_res_ns
```

`ts_res_ns` comes from `caps` (40). It is never a constant in host code.
With `s=0` the phase is always 0, so the resolution is 1000 ns.

Events recorded while the sync clock runs and after `sync stop`, from one
device (`s` returns to 0 after `sync stop`, and `c` is then the free-running
timer):

```
> ts get 10
< OK count=4 overflow=0
<   in=0x00000001 c=2 p=12 s=1
<   in=0x00000000 c=3 p=24 s=1
<   in=0x00000001 c=4 p=0 s=1
<   in=0x00000000 c=107 p=0 s=0
```

### 32-bit Count Extension

`raw_count` is a 32-bit value that wraps after approximately 71.6 minutes.
The host extends it to 64 bits:

```
if raw_count < previous_raw_count:
    high_bits += 1
extended_count = (high_bits << 32) | raw_count
```

Keep a separate counter per device per source (sync vs. free-running).

### Reconcile (Straddle Correction)

The device captures three DMA channels (input snapshot, count, phase) via a
shared DREQ trigger. The bus arbiter introduces a few tens of nanoseconds of
skew between channels. When a capture straddles a microsecond boundary,
`count` and `phase` may be inconsistent.

**Algorithm** (all candidates use `ts_res_ns` from `caps`):

1. For each event, generate 3 candidates:
   - `as-is`: `count * 1000 + phase * ts_res_ns`
   - `count-1`: `(count - 1) * 1000 + phase * ts_res_ns`
   - `count+1`: `(count + 1) * 1000 + phase * ts_res_ns`
2. Given K events from the same physical time (across channels or devices),
   enumerate all 3^K combinations and select the one that minimizes the total
   pairwise absolute difference.
3. For K <= 8, search exhaustively (3^8 = 6,561 combinations). For larger K
   the events are left as-is with a warning.

**Grouping events for reconcile:**

- Events with `raw_count` within +/-1 of each other belong to the same group;
  a gap of 2 or more starts a new group.
- A single event (K=1) cannot be corrected and uses the as-is value.
- All events in a group must have the same `sync_active`.
- Cross-device reconcile requires `sync_active=1` (shared clock). Events with
  `sync_active=0` from different devices use independent timers and cannot be
  compared.

**Achieved precision:**
- Same device, multiple channels: about 40 ns (DMA arbiter jitter only)
- Cross-device, same channel: <= 500 ns (verified with 500+ events)
- Cross-device, multiple channels: <= 500 ns

## 9. Device Discovery

### Enumeration Procedure

1. List all serial ports on the system.
2. Filter by USB properties:
   - VID = `0x2E8A`
   - PID = `0x000A`
   - Product string, when the OS provides one, starts with `"Pochi"`
3. For each matching port: open it, assert DTR, send `version` and require
   `proto=2`; a device reporting anything else is reported as unsupported,
   not listed as usable.
4. Send `info` and parse `uid` and `devnum`.

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

## 10. Pin Map and Channel Convention

### Channels and pins

Every mask on the wire (the eight map values, `read`/`state`/`write`, pattern
`out_bits`, `ts arm` masks, event and timestamp `in=` values) uses **physical
GP bit positions**. Logical channels ch0-ch24 are a host display concept.

| Channel | GP pin | Bit |
|---|---|---|
| ch0-ch22 | GP0-GP22 | bit0-bit22 |
| ch23 | GP26 | bit26 |
| ch24 | GP27 | bit27 |
| (not DIO) | GP23, GP24, GP25, GP28 | bit23-25, bit28: always 0 in every mask |

`VALID_DIO_MASK = 0x0c7fffff`. A mask that sets a bit outside it is rejected
by the host before sending, and by the device (`ERR BAD_PARAM` for command
masks, `ERR BAD_MAP` for map values).

Every SDK exposes the same helpers, and the CLI, GUI and VS Code extension use
only these (never their own bit arithmetic):

- `ch_to_gp(ch)` -- channel 0-24 to GP number
- `gp_to_ch(gp)` -- GP number to channel
- `VALID_DIO_MASK`
- `pin_label(gp)` -- display label such as `GP26 (ch23)`

### Map semantics

| Field | Meaning |
|---|---|
| `dir` | 1 = output, 0 = input |
| `pu` / `pd` | pull-up / pull-down on an input pin (never both) |
| `def` | initial logical output level |
| `opol` | output polarity: the pin is driven with `logical ^ opol` |
| `ipol` | input polarity: the host sees `physical ^ ipol` |
| `edge` | inputs that raise `! INPUT` events (section 7) |
| `flags` | reserved, must be 0 |

**Default map** (power-up when no map is saved, and after `map default`): every
DIO pin is an input with pull-down and edge enabled, no polarity inversion:

```
> map default
< OK
> map get
< OK v=2 flags=0x00 dir=0x00000000 pu=0x00000000 pd=0x0c7fffff def=0x00000000 opol=0x00000000 ipol=0x00000000 edge=0x0c7fffff
```

### Persistence

`map save` stores the map, with the device number, in a 42-byte flash block
whose first four bytes are the ASCII magic `PCH2`. A block with any other
magic is ignored: the device starts with the default map and device number 255.

### TOML Format

Host-side tools read `map.toml` and `pattern.toml` and convert them to the
`map set` / `pattern add` commands above. The schema is defined in
[`config-files.md`](config-files.md) and its fixtures in
[`fixtures/`](fixtures/); it is not repeated here.

## 11. Pattern Summary

- Step = `out_bits` (logical, physical GP bits, subset of `dir`) + `hold_ticks`
  (u32, 1 tick = 200 ns, at least 1). Text form `<out_bits>:<hold_ticks>`.
- Capacity is `caps.pattern` (256). The 257th step is `ERR TOO_LONG`:

  ```
  > pattern add 0x0:1
  < ERR TOO_LONG
  > pattern status
  < OK state=loaded step=0 loops=0 total=256
  ```

- `once` plays one pass, `loop <N>` plays N passes (1-65535).
- One step lasts `hold_ticks x 200 ns + 133 ns`.
- A step on a non-output pin is refused (`ERR BAD_PARAM`), as is `hold_ticks`
  of 0.

## 12. Multi-Device Sync Protocol

### Overview

Multiple Pochi-DIO devices share a common time base by connecting their GP28
pins together on a single bus. One device acts as master (outputs the sync
clock), and all others act as slaves (count the clock edges).

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
  (Timestamp capture works as normal, with s=1)

Phase 4 -- Stop
  Host -> Master: sync stop    (stop clock output)
  Host -> Slave1: sync disarm  (return to idle)
  Host -> Slave2: sync disarm
  Host -> Master: sync disarm
```

### Sync Pulse Waveform

The master outputs a 3-pulse preamble to distinguish the sync signal from
noise. Each preamble pulse is 5 us wide (10x wider than the 500 ns 1 MHz clock
pulses). The 4th rising edge at 30 us is the sync point where all devices
reset their counters to zero.

```
  Idle (Low)
  -----+
       |  P1      P2      P3      SYNC EDGE      1MHz Clock
       +--+  +----+  +----+  +------------+ +-+ +-+ +-+ ...
          +--+    +--+    +--+             +-+ +-+ +-+ +-+ +...
          5us 5us 5us 5us 5us 5us  10us      500ns H/L = 1MHz
                                    ^
                               Zero point
                               (all counters reset)
```

### Precision

- **Drift**: zero. All devices count edges of the same physical clock.
- **Cross-device accuracy**: <= 500 ns after host-side reconcile (verified
  with 500+ events in hardware testing).
- **Residual jitter** (about 480 ns max): caused by PIO sampling phase
  differences between devices. It cannot be eliminated by reconcile alone.
