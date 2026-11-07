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

Opening or closing the port, changing DTR or RTS and changing the baud rate
**never change the outputs**. Closing the port is not a safety event: an
application that disappears is detected by the watchdog (section 4,
"Safety"), not by the state of the port.

### Data Integrity

Text lines carry **no checksum**. The integrity of the link relies on the CRC
and retransmission of USB data packets. A damaged or truncated line is answered
with an error and changes nothing; the next line is parsed normally:

- a missing argument is `ERR BAD_PARAM`;
- a byte outside printable ASCII (and TAB) inside a line is not skipped: in a
  number it is `ERR BAD_PARAM`, in the command name or as invalid UTF-8 it is
  `ERR UNKNOWN_CMD`;
- a line longer than 256 bytes is `ERR LINE_TOO_LONG`.

A truncation that is itself a valid command (for example a number that lost its
last digit) cannot be detected. A host that needs certainty reads the result back
(`state`).

**Why there is no line checksum.**

- The device is connected by USB to one host. USB data packets are protected by a
  CRC and are retransmitted by the hardware, so a bit error on the cable never
  reaches the text layer.
- What damages a line in practice is the host side: a write cut short, two
  writers sharing one port, a wrong encoding. A checksum computed by the same
  faulty host over the faulty content would not catch any of these.
- A checksum would make the protocol harder to type in a terminal.

**When this has to be reconsidered.** If a transport other than USB (for example a
TCP relay for a remote device, or a serial line without hardware retransmission) is
ever supported, the link no longer has the integrity described above. The transport
must then provide it (an authenticated, checksummed stream) or the protocol gets a
line checksum under a new feature bit. Until then none is defined, and a host must
not assume that the text protocol is safe on such a transport.

**The behaviour is fixed by golden transcripts** (`protocol/golden/boundary.txt`), not
only by this text:

| Case in `boundary.txt` | What it fixes |
|---|---|
| `line length 257 bytes is refused with one ERR LINE_TOO_LONG, the stream recovers at the next line` | An over-long line gives exactly one error, and the next line (`ping`, `pattern status`) is answered normally |
| `line length 300 bytes ending in reset: one error, the tail is discarded, the device does NOT reset` | The discarded tail is never executed, so a line cut and joined with `reset` does not reset |
| `a valid line right after an overlong one is not affected` and `two overlong lines in a row give one error each` | Re-synchronisation happens at the next terminator |
| `boundary_truncated_line_does_not_change_outputs` | A truncated line (missing argument) is `ERR BAD_PARAM`; outputs, map and state are unchanged |
| `boundary_invalid_chars_rejected` | A non-printable or non-ASCII byte makes the token invalid (`ERR BAD_PARAM` in a number, `ERR UNKNOWN_CMD` in a name) and nothing is executed |

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
| Feature bits | `0x` + 8 lower-case hex digits | `0x000000ff` |
| Counts, quantities, times | unitless decimal; the unit is part of the key name (`ts_res_ns`, `tick_ns`, `t=` in microseconds) | `total=2` |

### Counted multi-line responses

A response whose header contains `count=<N>` is followed by **exactly N**
continuation lines, each starting with two spaces. `count=` is reserved for
this form: no single-line response uses it. A multi-line response without a
`count=` header does not exist. With `count=0`, no continuation line follows.

Three commands answer in this form: `ts get`, `excl get` and `help`.

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

The error names are listed in section 6. One error, `EXCLUSIVE`, carries
data after its name as `key=value` tokens: `ERR EXCLUSIVE group=<i>
mask=0x%08x`. A host takes the first token after `ERR` as the name and must
accept (and may read) further `key=value` tokens; it never fails to parse
such a line.

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
< OK dio=25 out=0 in=25 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x000000ff
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
  - bit 2 (`FEAT_WDOG = 0x4`) -- `wdog`, `safety`, `failsafe clear`, `! FAILSAFE`
  - bit 3 (`FEAT_EXCL = 0x8`) -- `excl`
  - bit 4 (`FEAT_OUTRESET = 0x10`) -- `outputs reset`
  - bit 5 (`FEAT_RSTINFO = 0x20`) -- `rstinfo`
  - bit 6 (`FEAT_USBSAFE = 0x40`) -- `usbsafe`
  - bit 7 (`FEAT_PADS = 0x80`) -- `pads`

A bit is set only when its feature is in the firmware. A host sends a command
only when its bit is set (an older firmware answers `ERR UNKNOWN_CMD`). New
features are added to `proto=2` and announced by a feature bit; `proto` changes
only when the meaning of an existing command changes.

`out` and `in` follow the direction mask:

```
> map set flags=0x00 dir=0x00000003 pu=0x00000000 pd=0x0c7ffffc def=0x00000000 opol=0x00000000 ipol=0x00000000 edge=0x0c7ffffc
< OK
> caps
< OK dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x000000ff
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
map, idle pattern engine, timestamp disarmed, sync idle, `subscribe` off, and
all safety state: watchdog off, failsafe cleared, no exclusive group,
`usbsafe` off); flash state (saved map, device number) survives. The outputs
are set to their defaults before `OK` is sent, and the device restarts with the
initial state of the saved map (section 10, "Initial state after a restart").

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

### Safety

Pochi-DIO is a general DIO device. For uses where an output must not misbehave
(for example switching relays) it has these safety functions. All of them are
**volatile**: they return to their defaults at every restart (section 10,
"Persistence").

**The safe state** is every output pin at its initial value `def` of the
current map (a logical level, converted with `opol`; input pins are not
changed). It is the same definition as the state the device starts in after a
restart, and it is what a watchdog trip, a USB loss (with `usbsafe`) and
`outputs reset` produce. There is no separate "off polarity": a pin that must be
OFF in the safe state has its `def` on the OFF side. A pin whose `def` is ON
is ON in the safe state.

The transcripts of this section are in `protocol/golden/safety.txt`.

#### `wdog <ms>`

Enable or disable the watchdog. `0` disables it, `100`..`10000` enables it.
**The watchdog is disabled by default**; it runs only after the host enables it.
CDC only.

```
> wdog 99
< ERR BAD_PARAM
> wdog 500
< OK
> wdog 0
< OK
```

Errors: `ERR BAD_PARAM` (out of range, not a number, missing or extra
argument; the previous setting is kept).

The timer is restarted by **every command that is answered `OK`** on CDC, at the
instant the `OK` is returned. These do not restart it: `ERR` responses, unknown
commands and malformed lines (`ERR UNKNOWN_CMD`, `ERR LINE_TOO_LONG`), binary frames
with a wrong CRC, an `OK` on HID, and DTR or USB state changes. When
`now - last_ok >= timeout` the watchdog **trips** (a deadline hit exactly trips;
1 microsecond earlier does not), before any command that arrives later is
processed. A trip puts the outputs in the safe state, sets the failsafe latch
(below) and sends `! FAILSAFE cause=wdog`. A running pattern is stopped (no
`! PATTERN_DONE`, the steps stay loaded). The firmware aims to finish the trip
within 50 ms of the deadline; this is measured on hardware, not by the
transcripts.

The application that enables the watchdog is responsible for the heartbeat:
send `ping` periodically (a period of timeout/4 or less, from a dedicated
thread). Choose a timeout larger than the longest
time the device needs to answer: `map save` and `devnum` write flash and take
longer than other commands. The lower bound, and why no number is given yet, is
under "Persistent and volatile settings" below.

A command-line tool that connects, runs one command and exits has no heartbeat:
the device trips `timeout` after the tool exits.

#### `safety`

Read the safety state. HID: allowed.

```
> safety
< OK wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0
> wdog 500
< OK
> safety
< OK wdog_ms=500 remaining_ms=500 failsafe=0 cause=none usbsafe=0 excl=0
```

Response fields:
- `wdog_ms=<n>` -- configured timeout, `0` = disabled
- `remaining_ms=<n>` -- time left, rounded up to whole milliseconds, read
  before this command restarts the timer; `0` when disabled or latched
- `failsafe=<0|1>` -- the failsafe latch
- `cause=<none|wdog|usb>` -- the cause of the latch; the first cause is kept
- `usbsafe=<0|1>` -- the `usbsafe` setting
- `excl=<n>` -- number of exclusive groups

#### Failsafe latch and `failsafe clear`

A trip sets the **latch** (`failsafe=1`). It stays set until `failsafe clear`;
the device never clears it by itself. The watchdog setting is kept.

While the latch is set the device answers `ERR FAILSAFE` to: a `write` that puts
any target pin at a value other than its `def`, `pattern run`, `map set` and
`map default`. It accepts everything else, in particular a `write` that only
writes `def` values, `outputs reset`, `pattern add`, `state`, `safety`, `ping`
and `failsafe clear`.

```
> wdog 100
< OK
(100 ms without an OK)
< ! FAILSAFE cause=wdog
> write 0x1 0x1
< ERR FAILSAFE
> write 0x0 0x1
< OK
> failsafe clear
< OK
```

`failsafe clear` (CDC only) releases the latch (`failsafe=0`, `cause=none`)
and restarts the watchdog timer; the outputs stay where they are. It is `OK`
also when no latch is set. If the host sends no heartbeat afterwards, the device
trips again.

#### `! FAILSAFE`

```
< ! FAILSAFE cause=wdog
```

Sent once when the latch is set (not repeated while it is set). It is sent only
while DTR is asserted and the USB link is configured, like every event, so it may
be missed: `safety` is the source of truth. A trip caused by losing the USB link
(`cause=usb`) cannot be sent, because the link is gone.

#### `outputs reset`

Put every output pin at its initial value `def` (the safe state). Stops a
running pattern (the steps stay loaded, no `! PATTERN_DONE`). Input pins are
not changed and the latch is not changed. **It always succeeds**: it is never
refused with `BUSY`, `NO_RESOURCE` (no outputs configured: `OK`, nothing to do),
`FAILSAFE` or `EXCLUSIVE`. Allowed on HID.

```
> outputs reset
< OK
```

(An earlier draft called this `alloff`; that command does not exist.)

#### `excl set <mask>...` / `excl clear` / `excl get`

Exclusive groups: of the pins of a group, at most one may be ON.

```
> excl set 0xc
< OK
> excl get
< OK count=1
<   mask=0x0000000c
> write 0x4 0x4
< OK
> write 0x8 0x8
< ERR EXCLUSIVE group=0 mask=0x0000000c
> write 0x8 0xc
< OK
```

`excl set` takes 1 to 16 masks and replaces all groups at once (atomically). Each
mask is a subset of the output pins with at least 2 bits; groups may overlap.
`excl clear` removes all groups. `excl set` and `excl clear` are CDC only. `excl
get` answers in the counted form, groups in the order they were set.

Errors:
- `ERR BAD_PARAM` -- no mask, more than 16, a mask with fewer than 2 bits or with
  a pin that is not an output, not a number; the previous groups are kept
- `ERR BUSY` -- a pattern is running (`excl set` and `excl clear`)
- `ERR EXCLUSIVE group=<i> mask=0x%08x` -- the group would be violated by the
  current output state, by a step already loaded with `pattern add`, or by the
  `def` of the current map. Nothing is set. `<i>` is the 0-based index of the
  first violating group

An instruction that changes the outputs is checked **against the state after it**:
if two or more pins of a group would be ON, the whole instruction is refused,
with `ERR EXCLUSIVE group=<i> mask=0x%08x` (the first violating group), and
nothing changes. Switching one pin OFF and another ON in a single `write` is
therefore allowed. This applies to `write`, to every step of `pattern add` (one
violating step adds none), and to `map set` (its `def`). A map whose `def`
would put two pins of a group ON is refused at definition time, because the safe
state and `outputs reset` are applied without a check.

`map default` is `ERR BAD_MAP` while groups exist (the default map has no output
pins); `map set` is `ERR BAD_MAP` if a group has a pin that is not an output in
the new `dir`. Send `excl clear` first.

#### `usbsafe on|off`

Off by default. With `usbsafe on`, when the USB device leaves the configured
state after having been configured once (bus suspend, bus reset, disconnect),
the device trips with `cause=usb`: outputs to the safe state, latch set. The
latch stays set after the host re-enumerates the device; check `safety`, then
`failsafe clear`. Nothing trips during the first enumeration after power-up.
CDC only. Errors: `ERR BAD_PARAM`.

```
> usbsafe on
< OK
```

`usbsafe` is meaningful only if the board is powered from a second source
(VSYS): a bus-powered board stops when the cable is pulled. A host operating
system that suspends an idle device (Linux `power/control=auto`, Windows
selective suspend) can trigger it; keep the port powered.

#### `rstinfo`

The cause and time of the last restart. HID: allowed.

```
> rstinfo
< OK cause=por uptime_ms=0 boot=0x00000001
```

Response fields:
- `cause=<por|wdt|soft|bor|other>` -- power-on, hardware watchdog, software reset
  (including the `reset` command), brown-out, other
- `uptime_ms=<n>` -- milliseconds since the restart (64-bit)
- `boot=0x%08x` -- a value that is different at every restart (the value has no
  other meaning; the transcripts use a counter starting at 1). A host that sees
  a different `boot` knows the device restarted and re-applies its safety
  settings.

#### `pads`

The recorded outputs and the level read back from the pads of the output pins,
both as logical values. HID: allowed.

```
> pads
< OK out=0x00000005 pad=0x00000005
```

`out` is the logical output latch (as in `state`). `pad` is the pad level of each
output pin converted to a logical level with `opol`; input pins read 0. A
difference means something outside the device drives the pin.

#### Persistent and volatile settings

One table for what survives a restart, what writes flash, and what the device
sends on its own. "Unsolicited line" means a `! ...` event (section 7) that the
device sends without a request. Nothing else is ever sent unasked.

| Setting | Set by | Stored in flash | After every restart | Unsolicited line |
|---|---|---|---|---|
| Pin map (`dir` `pu` `pd` `def` `opol` `ipol` `edge`) | `map set` changes RAM only; **`map save` writes flash**; `map default` resets RAM only | Only what `map save` stored | The saved map, or the default map (all inputs, pull-down) if none or if it is invalid | None |
| Device number | **`devnum <n>` writes flash at once** | Yes | The saved number, or 255 (unassigned) | None |
| Output levels (`write`, pattern, `outputs reset`) | `write`, `pattern ...` | No | Every output pin at its `def` of the saved map | `! PATTERN_DONE` or `! PATTERN_TIMEOUT` when a pattern run ends (always, `subscribe` is not needed) |
| `subscribe` | `subscribe on\|off` | No | Off | `! INPUT` while on, for input pins in `edge` only; nothing for output pins |
| Pattern | `pattern add\|run\|stop\|reset` | No | Idle, no steps | See output levels |
| Timestamp | `ts arm\|disarm` | No | Disarmed, ring empty | None (read with `ts get`) |
| Multi-device sync | `sync ...` | No | Idle | None |
| Watchdog | `wdog <ms>` | No | Disabled | `! FAILSAFE cause=wdog` when it trips |
| Failsafe latch and `cause` | A trip; `failsafe clear` | No | Released | `! FAILSAFE` once per trip |
| Exclusive groups | `excl set\|clear` | No | None | None (`ERR EXCLUSIVE` answers the offending command) |
| `usbsafe` | `usbsafe on\|off` | No | Off | `cause=usb` is latched when the link is lost, so the event cannot be delivered; read `safety` after reconnecting |

**Commands that write flash.** Exactly two: `map save` and `devnum <n>`. Every other
command, including `map set`, `map default`, `write`, `reset`, `bootsel` and the
safety commands, leaves flash alone. Each write erases and programs one flash sector
while the device processes no commands, and flash endurance is finite: do not call
them periodically. **Bench measurement (2026-11-06, one device, 40 writes each): `map save` 34.9-36.4 ms, `devnum` 35.0-36.5 ms, median 35.5-35.8 ms.** That is the time the device is busy; it is a typical value, not a guaranteed maximum (erase time varies with the flash part, temperature and wear).

**What a restart does not carry over.** After power-on, `reset`, a hardware
watchdog reset or a panic the device is in the state the saved map defines for each
pin (section 10, "Initial state after a restart"). The failsafe latch, exclusive
groups, watchdog, `usbsafe`, pattern, timestamp and `subscribe` are not carried over.
A pin that must be OFF after a restart (and in the safe state: a trip, USB loss with
`usbsafe`, `outputs reset`) has its `def` on the OFF side. These states use the same
value `def`: there is no separate "off polarity" setting.

**A session that only drives outputs sees no unsolicited line.** With no
subscription, pattern or failsafe trip nothing is sent, also across DTR changes and
`outputs reset` (golden case `events_output_only_session_is_silent` in
`protocol/golden/events.txt`).

**Choosing the watchdog timeout.** The timer restarts when a command is answered
`OK`. A flash-writing command (`map save`, `devnum`) is answered only after the
write, so the time between two `OK`s can be as long as the heartbeat period plus the
write. The lower bound for `wdog` is therefore

    timeout > (longest flash write) + (heartbeat period)

with the protocol minimum of 100 ms. With the SDK heartbeat (period `timeout / 4`, at most 1 s) and the measured
36.5 ms, the longest gap between two `OK` answers around a write is about `timeout / 4 + 37 ms`, which is
below the timeout for every allowed value (100 ms: about 62 ms). Because 36.5 ms is a bench value and not a
guaranteed maximum, the safe procedure stays the same: do not send `map save` or `devnum` while the watchdog is
enabled; send `wdog 0`, save, then enable the watchdog again.

After a restart the host re-applies, in this order: `excl set`, `usbsafe`,
`wdog` (the watchdog last; never send `excl clear` first because `excl set`
replaces atomically).

#### Transports

`wdog`, `excl set`, `excl clear`, `usbsafe` and `failsafe clear` can weaken the
safety and are **CDC only** (a HID request is refused with
`TRANSPORT_NOT_SUPPORTED`). `safety`, `outputs reset`, `excl get`, `rstinfo` and
`pads` also work over HID. Only an `OK` on CDC restarts the watchdog timer. A text
host never sees `TRANSPORT_NOT_SUPPORTED`.

#### Order of the checks

When several errors apply, the first of this list is reported: (1) parsing
(`BAD_PARAM`, `UNKNOWN_CMD`, `LINE_TOO_LONG`); (2) command arguments and map
validation (`BAD_PARAM`, `BAD_MAP`); (3) state (`NO_RESOURCE`, `BUSY`, `NOT_RUNNING`);
(4) `FAILSAFE`; (5) `EXCLUSIVE`. `outputs reset` is checked only against (1).

### `help`

Counted multi-line response, one line per command family. Text mode only.

```
> help
< OK count=24
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
<   wdog <ms>                                Set the watchdog timeout (0=off, 100-10000)
<   safety                                   Get the safety state
<   failsafe clear                           Release the failsafe latch
<   outputs reset                            Return all outputs to their defaults
<   excl set|clear|get                       Exclusive output groups
<   usbsafe on|off                           Failsafe when the USB link is lost
<   rstinfo                                  Get the reset cause and uptime
<   pads                                     Read the output pad levels
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
| `wdog <ms>` | 0 or 100-10000 (CDC only) | `OK` |
| `safety` | -- | `OK wdog_ms=<n> remaining_ms=<n> failsafe=<0\|1> cause=<none\|wdog\|usb> usbsafe=<0\|1> excl=<n>` |
| `failsafe clear` | -- (CDC only) | `OK` |
| `outputs reset` | -- | `OK` |
| `excl set <mask>...` / `excl clear` | 1-16 masks / -- (CDC only) | `OK` |
| `excl get` | -- | `OK count=<N>` + N lines `  mask=0x%08x` |
| `usbsafe on\|off` | -- (CDC only) | `OK` |
| `rstinfo` | -- | `OK cause=<por\|wdt\|soft\|bor\|other> uptime_ms=<u64> boot=0x%08x` |
| `pads` | -- | `OK out=0x%08x pad=0x%08x` |
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
| `FAILSAFE` | The failsafe latch is set and the command would move an output away from its `def` (`write`, `pattern run`, `map set`, `map default`) |
| `EXCLUSIVE` | An exclusive group would be violated. Written `ERR EXCLUSIVE group=<i> mask=0x%08x`: the first violating group (0-based) and its mask |
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
`SYNC_STATE` 0x08, `NO_RESOURCE` 0x0A, `NOT_RUNNING` 0x0C, `FAILSAFE` 0x0D,
`EXCLUSIVE` 0x0E (the only status with a response payload: `group:u8, mask:u32`).

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

Push events are asynchronous lines prefixed with `! `. There are exactly four.

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

### `! FAILSAFE`

Sent once when the failsafe latch is set (section 4, "Safety").

```
< ! FAILSAFE cause=wdog
```

`cause=<wdog|usb>` -- the reason of the trip. Not repeated while the latch is
set; sent again after `failsafe clear` and a new trip. Like every event it is
dropped when it cannot be delivered, so `safety` is the source of truth.

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
| `def` | initial logical output level. It is also the **safe state** of the pin (section 4, "Safety") |
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

### Initial state after a restart

After every restart (power-on, `reset`, hardware watchdog, panic) the device
starts in the state the saved map defines for **each pin separately**, or the
default map if none is saved: an output pin is at its logical level `def`
(converted to the electrical level with `opol`), an input pin has the pull-up,
pull-down or no pull (high impedance) that `pu` / `pd` define. The failsafe
latch, exclusive groups, watchdog, `usbsafe`, pattern, timestamp and `subscribe`
are not carried over. Before the firmware starts (boot ROM, BOOTSEL) the pins
have the chip's own default state, which the firmware cannot control.

**Declaring the initial state of each pin.** There is no separate setting: the
initial state is the saved map. Use `map set`, check it with `map get`, and
store it with `map save`. Example: GP0 is an active-high relay, GP1 is an
active-low relay, GP2 is an input with pull-up, GP3 is an input without pull,
all other inputs have the default pull-down:

```
> map set flags=0x00 dir=0x00000003 pu=0x00000004 pd=0x0c7ffff0 def=0x00000000 opol=0x00000002 ipol=0x00000000 edge=0x0c7ffffc
< OK
> map save
< OK
```

After every restart the pins are: GP0 low (relay OFF), GP1 high (relay OFF:
logical 0 with `opol=1` is the high level), GP2 pulled up, GP3 floating, the
other inputs pulled down. The reply of `map get` can be pasted back into
`map set` unchanged. A `map set` that was not followed by `map save` is lost at
the next restart, and the device returns to the default map (all pins inputs
with pull-down). A saved map that fails validation (for example a damaged flash
block) is ignored in the same way: the device starts with the default map and
drives no output.

The same map as `map.toml` (see [`config-files.md`](config-files.md)):

```toml
version = 2

[pins]
GP0 = { dir = "out", default = 0 }
GP1 = { dir = "out", default = 0, invert = true }
GP2 = { dir = "in", pull = "up" }
GP3 = { dir = "in", pull = "none" }
```

**Keep `def` on the OFF side.** `def` is always the logical level (ON = 1); the
conversion to the electrical level is done by `opol`. A pin whose `def` is 1
starts ON after every restart, whatever its `opol`. To keep a relay from
switching on at a restart, leave its `def` at 0 and set `opol` (`invert = true`)
for an active-low board. `def` is also the pin's safe state (section 4), so
the same value is applied on a failsafe trip.

| Stage | Pin state |
|---|---|
| Power-on, boot ROM, BOOTSEL | The chip's default. The firmware is not running and cannot control the pins. **Not yet measured**; if the board needs a defined level here, add an external pull resistor. |
| Firmware start, until the pin state is applied (clock, pad setup, PIO setup) | Output drivers are not enabled; pulls are the chip's default. **Not yet measured.** |
| Initial state applied | Per pin as declared in the saved map (default map if none). The output value is written before the output driver is enabled, so no glitch of an old value appears at the moment the driver turns on. |
| USB enumeration and later | The state above is kept; USB start-up does not change any pin. |
| Panic / HardFault | Pins are released to inputs (high impedance) and the chip resets; afterwards the row "Initial state applied" holds. |

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
