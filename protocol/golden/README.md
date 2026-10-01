# Pochi-DIO v2 text protocol — golden transcripts

Golden transcripts are the reference record of the v2 text command protocol
(`proto=2`, REF-V2 section 3). The firmware, the host simulator
(`pochi-dio-sim`) and every SDK/CLI/extension test replay the same files, so a
transcript here is the single source of truth for wire-visible behaviour.

These files started as a **hand-written draft** (A0), written from the spec
and not recorded from a device, and are marked `# generated_by=hand`. They are
now replayed against the firmware (see "Replaying the files") and the replay
passes, so the firmware output equals the transcripts byte for byte. Every
difference found while doing so was resolved either by a firmware fix or by a
deliberate transcript revision; both are recorded in the "Revision log" below.
A transcript is part of the specification and must not be changed silently.

The files contain only protocol text (no keys, serial numbers, or secrets).
UID, device number and firmware version values are those of the simulator
(`uid=0000000000000000`, the firmware's `fw=0.1.3`); a different firmware
version changes `version-info.txt`, `reset.txt`, `errors.txt` and
`boundary.txt` and is a revision of these files.

## File layout

| File | Area |
|---|---|
| `version-info.txt` | `version` `caps` `info` `devnum` `ping` |
| `map.txt` | `map get/set/save/default`, R-M1 .. R-M5 validation |
| `io.txt` | `read` `write` `state` |
| `pattern.txt` | `pattern add/run/stop/reset/status`, R-PT rules |
| `timestamp.txt` | `ts arm/disarm/get/status`, `subscribe on/off` |
| `sync.txt` | `sync arm/master/start/stop/disarm/count` |
| `reset.txt` | `reset` `bootsel` `help` |
| `errors.txt` | every error name, unknown commands, removed forms |
| `boundary.txt` | line length 256/257/300, 256-step pattern limit, R-T5 |
| `events.txt` | asynchronous `! INPUT`, `! PATTERN_DONE`, `! PATTERN_TIMEOUT` |

One file covers one functional area. Cross-area behaviour (for example
timestamps taken while sync is clocking) lives in the file of the command
under test.

## File format

Files are ASCII, LF line endings, no trailing whitespace, no tabs.

The first three lines of every file are the header:

```
# proto=2
# generated_by=hand
# fw_commit=<sha>
```

* `proto` is the protocol version the transcript describes.
* `generated_by=hand` records the origin (written from the spec, not recorded
  from a device); since revision 1 the files are also replayed against the
  firmware, see "Replaying the files".
* `fw_commit` is the commit of the firmware sources (`pochi-dio`) whose replay
  the transcript passes, as a lowercase hex SHA (7 to 40 digits). A commit cannot
  name itself, so the stamp is set **after** the revision that changed the
  firmware or a transcript has been committed
  (`scripts/stamp-golden-fw-commit.sh`, in the `pochi-dio` repository; it sets
  every file to the current `HEAD`) and is committed as a header-only change.
  Until then it carries a `+wt` suffix (`<base sha>+wt`: that commit plus
  uncommitted changes); `check_golden.py` reports such a stamp as a warning.
  Every file of one revision carries the same `fw_commit`.

Every other line is one of the following, identified by its prefix.

| Prefix | Meaning |
|---|---|
| `> ` | Request line. The text after `> ` is sent to the device, terminated with CR/LF. |
| `< OK` | Success response: `< OK` or `< OK key=value key=value ...` |
| `< ERR ` | Error response: `< ERR NAME` |
| `<   ` | Continuation line of a counted response. On the wire the line is 2 spaces + payload; the golden line is `< ` (prefix and one space) + that wire line, so `<` is followed by three spaces |
| `< ! ` | Asynchronous event: `< ! NAME key=value ...` |
| `# ` | Comment. Ignored by replay. |
| `~ ` | Harness directive (see below). Not sent to the device. |

A blank line ends a **test case**. Comment-only blocks (such as the header)
are not test cases.

### Requests and responses

* Every `>` request is followed by exactly one response header (`< OK ...` or
  `< ERR NAME`) before the next request.
* A counted response carries `count=N` in its header and is followed
  immediately by exactly `N` continuation lines. `count=0` has no continuation
  lines. A continuation line is matched literally against `< ` + the wire
  line (2 spaces + payload). The payload itself starts with its own text, for
  example `in=0x00000001 c=2 p=0 s=0`.
* Events (`< !`) are never part of a response. They appear on the line where
  they occur in the stream, after the response of the preceding request and
  after the directive that caused them.
* The replayer also fails a case when the device emits any line that the
  transcript does not list, so a case that lists no response asserts silence
  (see the `send_hex` negative cases of R-T5 in `boundary.txt`).
* The replayer compares lines byte-for-byte (after CR/LF removal). Numbers are
  therefore in the canonical output form of R-T3: masks and bit values as
  `0x%08x` (lowercase, 8 digits, zero padded), flags as `0x%02x`, counts and
  other quantities in decimal.
* Requests may use any spelling the spec allows (case-insensitive command
  names, decimal or `0x` hex numbers). Responses always use the canonical form.

### Test cases are independent

The harness resets the device model **before every test case**:

* default pin map in RAM, and the saved map in flash erased;
* device number unassigned (`255`), flash settings erased;
* pattern engine idle with no steps loaded;
* timestamp disarmed with an empty ring; `subscribe off`;
* sync state idle;
* text mode, simulated time `t = 0`, all input pins driven to physical level 0.

A case therefore contains its own set-up. State that survives `reset` within a
case (saved map, device number) is the flash state; RAM state does not survive.

### Directives (`~`)

Directives drive the device model from outside. They take zero simulated time
unless they say otherwise. The device processes request lines in zero
simulated time as well, so simulated time only moves through `~ advance`.

| Directive | Effect |
|---|---|
| `~ in=0x%08x` | Drive the **physical** level of all input pins. Bits for pins that are not inputs are ignored. Takes effect at the current simulated time. |
| `~ advance us=<n>` / `~ advance ns=<n>` | Advance simulated time by `n` microseconds / nanoseconds. Events due in that interval are emitted, in time order, right after the directive. |
| `~ send_hex <hh> <hh> ...` | Send raw bytes (hex, space separated) exactly as given, with no terminator added. |
| `~ expect_pins out=0x%08x` | Assert the **physical** level of all output pins at the current simulated time (pins that are not outputs read 0). Used to check output polarity (R-PT4): physical level = logical output XOR `opol`. A mismatch fails the case. |
| `~ sync_edge` | An external sync master drives a valid sync edge on the sync line (for a device in the slave-armed state). |
| `~ fault pio_stall` | Make the pattern engine stall (no further progress, no completion) from the next `pattern run`. Used to reach the pattern timeout. |
| `~ fault flash_write` | Make the next flash write (`map save`, `devnum`) fail once. Used to reach `ERR FLASH`. |

`send_hex` may legitimately elicit responses without a `>` request line; those
responses are written directly after the directive.

R-T5 uses `send_hex` because it needs bytes that are not text. The R-T5 rule
covers a stream that left text mode but has **not reached frame sync**: a
non-zero, non-printable first byte (for example `0x03`) starts binary
reception, and CR/LF before the first `0x00` returns the device to text mode
with one `ERR UNKNOWN_CMD`. A leading `0x00` **is** the sync byte; after it,
`0x0d` and `0x0a` are ordinary COBS body bytes (a code byte may legitimately be
`0x0a` or `0x0d`) and produce no response. Both sides are covered in
`boundary.txt`. A binary frame response is not representable in a text
transcript, so a frame that really completes is outside this corpus.

### Simulation model assumed by the transcripts

* Simulated time starts at 0 when a case starts. Event time `t=` is the
  simulated time in whole microseconds (floor).
* One pattern step takes `hold_ticks x 200 ns + 133 ns` (R-PT5). `step=` in
  `pattern status` is the 0-based index of the step currently held.
* The timestamp `c=` is the free-running microsecond counter (`s=0`, `p=0`),
  or while sync is clocking the sync edge count (`s=1`) with `p` the 40 ns
  sub-phase `floor((time within the microsecond) / 40 ns)`, 0..24.
* Input logical level = physical level XOR `ipol` (input pins only). All
  logical values in responses and events are logical.
* `VALID` = `0x0c7fffff` (GP0-GP22 and GP26-GP27). GP23/24/25/28 are not DIO.
* `state out=` is the logical output latch (the value `write` and pattern
  `out_bits` use). The physical pin level is the latch XOR `opol` (R-PT4).
  After a pattern completes, stops, resets or times out, the latch holds the
  last output step's logical value.
* Pattern events (`! PATTERN_DONE`, `! PATTERN_TIMEOUT`) are always pushed.
  `! INPUT` is pushed only after `subscribe on`.

## Rule tags

Comments carry the REF-V2 rule they exercise (`R-T1`, `R-M1(dir)`, ...) so a
reviewer can find the transcript for a rule with a plain `grep`. `R-M1(<f>)`
is the validity rule of map field `<f>`.

## Conventions used in comments

* `# len=N` immediately before a request states the exact byte length of that
  request line (terminator excluded). Tooling that loads the files should
  verify the annotation.
* `# ASSUMPTION:` marks behaviour that REF-V2 section 3 does not state
  explicitly. The replay against the firmware confirms every such line; a line
  that the firmware contradicted was corrected (`# REVISED:`) or the firmware
  was fixed (see "Revision log").

## Error coverage by transport

REF-V2 R-C2 asks for an explicit list of every error per transport. A transcript
is CDC text only; a binary frame or a HID report cannot be written in it. Every
error the firmware can answer is therefore listed here once per transport, and
each cell is either covered or marked `n/a` with the reason:

* `golden:<file>`: the transcript `<file>.txt` contains the `< ERR NAME` line;
* `probe`: not representable in a text transcript; the firmware probe in
  `sim/tests/error_transports.rs` provokes the error through a binary CDC frame
  or a HID report on the simulator and checks the status byte;
* `n/a: <reason>`: the error cannot occur on that transport.

| Error | CDC text | CDC binary | HID |
|---|---|---|---|
| `BAD_CMD` | n/a: the text parser has no command id and answers an unknown name with UNKNOWN_CMD | probe | probe |
| `BAD_PARAM` | golden:errors | probe | probe |
| `BAD_MAP` | golden:errors | probe | probe |
| `BUSY` | golden:errors | probe | probe |
| `FLASH` | golden:errors | probe | probe |
| `TOO_LONG` | golden:errors | probe | n/a: PATTERN_APPEND is CDC-only, HID answers TRANSPORT_NOT_SUPPORTED |
| `NOT_ARMED` | golden:errors | probe | n/a: GET_TIMESTAMPS, the only command that raises it, is CDC-only |
| `SYNC_STATE` | golden:errors | probe | probe |
| `NO_RESOURCE` | golden:errors | probe | probe |
| `NOT_RUNNING` | golden:errors | probe | probe |
| `TRANSPORT_NOT_SUPPORTED` | n/a: CDC carries every command, so a text request is never refused | n/a: CDC carries every command, so a binary request is never refused | probe |
| `UNKNOWN_CMD` | golden:errors | n/a: a binary frame carries a command id, an unknown id is BAD_CMD | n/a: a HID report carries a command id, an unknown id is BAD_CMD |
| `LINE_TOO_LONG` | golden:errors | n/a: a limit of the text line parser only | n/a: a limit of the text line parser only |

`sim/tests/error_transports.rs` fails when this table and the firmware disagree:
a firmware error (every `Status` and `TextError` variant) missing from the table,
a `probe` cell without a passing probe, a probe without its `probe` cell, or a
`golden:` cell whose transcript lacks the error.

## Checking the files

`check_golden.py` (Python 3, standard library only) validates the structure of
every file: header (including the `fw_commit` stamp), one response per request,
counted responses, `# len=N` annotations, R-T3 number formats, known error and
event names, known directives, and coverage (every command form has a
successful example, every error name, event, rule tag and boundary length
appears, every `golden:` cell of the error table is backed by its transcript).
It checks the transcripts only; it does not replay them.

```
python3 protocol/golden/check_golden.py
```

## Replaying the files

`sim/tests/golden.rs` replays every file on the simulator, which runs the
firmware's `runtime::Device` unchanged on a virtual clock: a fresh device per
test case, `>` lines sent with CR/LF, the lines the device emits after each
request or directive compared byte for byte with the `<` lines that follow it.
The directives map to the simulator as follows: `~ in=` sets the external input
levels and polls the device at that instant (so a `! INPUT` event is emitted
right after the directive); `~ advance` moves the virtual clock; `~ sync_edge`
is a sync edge from an external master; `~ fault pio_stall` / `~ fault
flash_write` arm a one-shot fault; `~ expect_pins` compares the physical output
levels. The replay is part of `cargo test` of the simulator (a separate crate:
the root `cargo test` of `pochi-dio` does **not** run it):

```
cd sim && cargo test --target <host triple>
```

The simulator tests run in the `lefthook` pre-commit and pre-push hooks of
`pochi-dio` and in the umbrella `scripts/test-all.sh`.

`scripts/sync-protocol-golden.sh` (in the parent repository) distributes this
directory to the consumer repositories; run it after every revision and check
with `--check`.

## Revision log

Revision 1 (replay against the firmware). Resolved differences between the A0
draft and the firmware:

| Area | A0 draft | Resolution |
|---|---|---|
| `version` | `fw=0.2.0` | Transcript follows the firmware: `fw=0.1.3`. A firmware version bump is out of scope here. |
| `caps` | `ring=32 feat=0x00000000` | Transcript follows the firmware: `ring=256` (`TS_RING_CAPACITY`), `feat=0x00000003` (FEAT_SYNC, FEAT_RESET). The ring-overflow cases in `timestamp.txt` now use 257 / 256 toggles. |
| `info` | placeholder uid `0123456789ABCDEF` | Transcript follows the simulator's fixed device id: `uid=0000000000000000`. |
| `pattern run once <n>` | `n` passes, `PATTERN_DONE loops=n` | Transcript revised: `once` is one pass and ignores `n` (only `loop` repeats), `loops=1`. |
| `ts get <max>` below the pending count | oldest events first | Firmware bug fixed (it returned the newest events and could corrupt the pending ones); the transcript is unchanged. |
| `ts disarm` | clears the ring and the overflow flag | Firmware fixed (`ts status` still showed the old events); transcript unchanged. |
| `ts` with `ipol` | events and rising/falling use logical levels | Firmware fixed (it used the physical pad level); transcript unchanged. |
| `pattern add` after `done` | `loops=0` again (Done -> Loaded) | Firmware fixed (the old pass counter stayed); transcript unchanged. |

Revision 2 (header and error list; no change to any transcript line). The
header gained the `fw_commit` stamp, and the error x transport list was added
("Error coverage by transport"). No wire-visible behaviour changed.
