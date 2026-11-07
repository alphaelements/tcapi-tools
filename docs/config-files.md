# Configuration files: `map.toml`, `pattern.toml` and `safety.toml` (schema v2)

Canonical definition of the three host-side TOML formats. Every implementation
(Rust / TypeScript / Python / C# SDKs, `pochi-cli`, the GUI and the VSCode
extension) must accept exactly this schema and reject everything else with the
errors listed in section 4. Conformance is checked against the fixtures in
[`docs/fixtures/`](fixtures/) (section 5).

> **Status: draft pending owner sign-off, except item 8 of section 6.** The
> schema shape of `map.toml` and `pattern.toml` follows REF-V2 section 4.3; the
> shape of `safety.toml` (section 7) follows the DCIT plan. The defaults, the
> pin-name grammar and the error message texts below were written by the
> implementer and are listed in section 6; do not copy them into another parser
> until they are approved. Item 8 (the pin rules of `safety.toml`) is approved.

Requirement: **R-TOML1** — `version` other than 2, unknown keys and
contradictory settings are errors. There is no lenient mode and no migration
of older layouts.

## 1. Common rules

- Every file starts with `version = 2` (integer). Missing `version` or any other
  value is an error.
- Any key not listed in this document is an error, at every level (top level,
  pin table, step table, `[watchdog]`, `[usb]`, exclusive group). Keys are
  case-sensitive.
- **Pin names** have the canonical form `GP(0|[1-9][0-9]*)`: the letters `GP`
  (upper case) followed by a decimal number without sign, leading zeros,
  spaces or non-ASCII digits. The number must be one of `0-22, 26, 27`, which
  are exactly the bits of `VALID_DIO_MASK`. `GP00`, `GP+5`, `gp1`, `GP23` are
  all invalid.
- **Line numbers (required).** Every error is reported as
  `<file>:<line>: <message>`, where `<line>` is the 1-based line of the
  offending element and `<message>` is the exact text from section 4:
  - unknown key / invalid value: the line of the key (for a pin entry, the line
    of the pin key, which also holds the inline table; for the `[pins.GPn]`
    sub-table form, the line of that header);
  - `safety.toml`: an error about a key inside `[watchdog]`, `[usb]` or an
    `[[exclusive]]` group is reported on the line of that key (for the inline
    spellings `watchdog = { ... }` / `exclusive = [ ... ]`, on the line of the
    key that holds the table); an error about a table as a whole, or about a key
    that is absent (`pins` missing), on the line of its header (the
    `[[exclusive]]` header of that group); a table of the wrong type
    (`watchdog = 800`, `[exclusive]`), on the line of that key or header;
    `too many exclusive groups`, on the header of the 17th group;
  - step errors: the line of the offending key inside that `[[step]]`; when the
    error concerns the step as a whole or a key that is absent (`out` and
    `out_bits` both present or both absent, `hold` missing), the line of the
    `[[step]]` header;
  - whole-file errors (`missing key "version"`, `pattern has no steps`): line 1;
  - `toml syntax:`: the line reported by the TOML parser.

  Fixtures state the expected line in `# expected_line: N`.
- **Check order.** Exactly one error is reported: the first failing check.
  1. TOML syntax.
  2. `version` (missing, not an integer, not 2). This comes before unknown keys,
     so a v1-style file is reported as an unsupported version.
  3. Unknown top-level keys.
  4. The remaining top-level keys, then the pins (map), the steps in file order
     (pattern) or the sections `watchdog`, `usb`, `exclusive` in that order
     (safety), each in the order of the tables in section 4.

  For several faulty pins in one map file, which pin is reported first is
  implementation-defined (the fixtures contain one fault each).
- The `flags` word of the device PinMap is reserved and always sent as 0. It is
  not a file key; `flags = ...` is an unknown-key error.

### `VALID_DIO_MASK = 0x0c7fffff`

Bit `n` corresponds to `GPn`. The mask covers bits 0-22 (GP0-GP22) and bits
26-27 (GP26, GP27). GP23, GP24, GP25 (on-board LED) and GP28 are not usable as
DIO. Any pin outside the mask is an error in `map.toml`, `pattern.toml` and
`safety.toml`.
Every mask field produced from these files (`dir`, `pull_up`, `pull_down`,
`out_default`, `out_polarity`, `in_polarity`, `edge`, each step's
`out_bits` and each exclusive group of `safety.toml`) is a subset of
`VALID_DIO_MASK`.

## 2. `map.toml`

```toml
version = 2

[pins]   # keys: GP0-GP22, GP26, GP27. Unlisted pins use the defaults below.
GP0  = { dir = "out", default = 0, invert = false }
GP1  = { dir = "in",  pull = "down", invert = false, edge = true }
GP26 = { dir = "in",  pull = "up" }
```

### Top-level keys

| Key       | Type    | Required | Default | Meaning                                    |
|-----------|---------|----------|---------|--------------------------------------------|
| `version` | integer | yes      | -       | Must be `2`.                               |
| `pins`    | table   | no       | empty   | Per-pin settings; keys are pin names.      |

### Pin keys (`[pins].GPn = { ... }`)

| Key      | Type                       | Applies to | Default  | Meaning |
|----------|----------------------------|------------|----------|---------|
| `dir`    | `"in"` \| `"out"`          | both       | `"in"`   | Pin direction. |
| `default`| integer `0` or `1`         | output     | `0`      | Level driven when the map is applied (before polarity). It is also the level the pin has after every restart and its safe state, so a pin that must start OFF keeps `default = 0`; for an active-low board set `invert = true`. |
| `invert` | boolean                    | both       | `false`  | Output: invert driven level. Input: invert sampled level. |
| `pull`   | `"up"` \| `"down"` \| `"none"` | input  | `"down"` | Internal pull resistor. |
| `edge`   | boolean                    | input      | `true`   | Include the pin in edge (change) detection. |

Pins not listed in `[pins]` are **input, pull-down, edge enabled, not inverted**.
An empty `[pins]` table (or no table at all) therefore yields the default map.
A pin listed with no keys (`GP3 = {}`) is identical to an unlisted pin.

### Resulting PinMap

The file is evaluated into these 32-bit masks (bit `n` = `GPn`). The fixtures
state them as `# expected: ...` comments.

| Mask           | Set when                                    |
|----------------|---------------------------------------------|
| `dir`          | pin is an output                            |
| `pull_up`      | input with `pull = "up"`                    |
| `pull_down`    | input with `pull = "down"` (or unlisted)    |
| `out_default`  | output with `default = 1`                   |
| `out_polarity` | output with `invert = true`                 |
| `in_polarity`  | input with `invert = true`                  |
| `edge`         | input with `edge = true` (or unlisted)      |

By construction `pull_up & pull_down == 0`, `edge & dir == 0`, and every mask is
within `VALID_DIO_MASK`. `pull = "none"` leaves the pin in neither pull mask.
The default map is `dir=0x00000000 pull_down=0x0c7fffff edge=0x0c7fffff` with all
other masks zero.

## 3. `pattern.toml`

```toml
version = 2
unit = "tick"          # "tick" (200 ns) | "ns" (multiples of 200 only) | "us"

[[step]]
out  = ["GP0", "GP2"]  # or: out_bits = 0x5
hold = 5
```

### Top-level keys

| Key       | Type                        | Required | Default  | Meaning |
|-----------|-----------------------------|----------|----------|---------|
| `version` | integer                     | yes      | -        | Must be `2`. |
| `unit`    | `"tick"` \| `"ns"` \| `"us"`| no       | `"tick"` | Unit of every step's `hold`. |
| `step`    | array of tables (`[[step]]`)| yes      | -        | At least one step; executed in file order. |

One tick is 200 ns (the device time base). Conversion to ticks:

| `unit`   | ticks                | Error                                              |
|----------|----------------------|----------------------------------------------------|
| `"tick"` | `hold`               | -                                                  |
| `"ns"`   | `hold / 200`         | `hold` not a multiple of 200                       |
| `"us"`   | `hold * 5`           | result does not fit in `u32` (`hold > 858993459`)  |

The tick count must be in `1..=4294967295` for every unit.

### Step keys (`[[step]]`)

| Key        | Type                        | Required     | Meaning |
|------------|-----------------------------|--------------|---------|
| `out`      | array of pin names          | one of `out`/`out_bits` | Pins driven high during the step; all other outputs low. `[]` is valid (all low). |
| `out_bits` | integer (decimal or `0x` hex) | one of `out`/`out_bits` | Raw output mask in physical GP bit positions; must be a subset of `VALID_DIO_MASK`. |
| `hold`     | integer                     | yes          | Duration of the step in the file's `unit`. |

`out` and `out_bits` are two spellings of the same value and may not be combined
in one step. The evaluated step list is `(out_bits, hold_ticks)` per step; the
fixtures state it as `# expected_step: out_bits=0x... hold_ticks=N` lines.

### Upload-time check (not a file error)

A pattern file is valid by itself, but when it is uploaded, every step's
`out_bits` must be a subset of the output pins (`dir`) of the map currently
active on the device (R-PT1). Otherwise the device refuses the pattern step with
`ERR_BAD_PARAM`. Hosts that know the map should report this before sending. This
is a property of the device state, so it has no fixture.

## 4. Errors

The message texts below are shown without the `<file>:<line>: ` prefix of
section 1. Position `N` in `step N` is 1-based. `<value>` placeholders are replaced by the
offending input. All of these are hard errors; nothing is applied to the device.

### All files

| Condition                         | Message |
|-----------------------------------|---------|
| `version` missing                 | `missing key "version"` |
| `version` not an integer          | `version must be an integer` |
| `version` is an integer other than 2 | `unsupported version: expected 2, got <value>` |
| unknown top-level key             | `unknown key "<key>"` |
| TOML syntax error (everything after `toml syntax: ` is parser specific) | `toml syntax: <parser message>` |

### `map.toml`

| Condition                               | Message |
|-----------------------------------------|---------|
| pin name not in `VALID_DIO_MASK`        | `invalid pin <name>: valid pins are GP0-GP22, GP26, GP27` |
| `pins` not a table                      | `pins must be a table` |
| pin entry not a table                   | `<pin>: pin must be a table` |
| unknown pin key                         | `unknown key "<key>" in <pin>` |
| `dir` not `"in"`/`"out"`                | `<pin>: dir must be "in" or "out"` |
| `invert` not boolean                    | `<pin>: invert must be a boolean` |
| `pull` on an output                     | `<pin>: pull is not allowed on an output pin` |
| `edge` on an output                     | `<pin>: edge is not allowed on an output pin` |
| `default` on an input                   | `<pin>: default is only allowed on an output pin` |
| `default` not `0`/`1`                   | `<pin>: default must be 0 or 1` |
| `pull` not `"up"`/`"down"`/`"none"` (including arrays such as `["up", "down"]`) | `<pin>: pull must be "up", "down" or "none"` |
| `edge` not boolean                      | `<pin>: edge must be a boolean` |

Pull-up and pull-down on one pin cannot be expressed: `pull` holds a single
value, so the device-level conflict (`pull_up & pull_down != 0`) cannot arise
from a valid file.

### `pattern.toml`

| Condition                               | Message |
|-----------------------------------------|---------|
| `unit` not one of the three values      | `invalid unit "<value>": expected "tick", "ns" or "us"` |
| `unit` not a string                     | `unit must be a string` |
| no `[[step]]` (absent or empty array)   | `pattern has no steps` |
| `step` present but not an array         | `step must be an array of tables` |
| step not a table                        | `step N: step must be a table` |
| unknown step key                        | `unknown key "<key>" in step N` |
| both `out` and `out_bits`               | `step N: out and out_bits are mutually exclusive` |
| neither `out` nor `out_bits`            | `step N: one of out or out_bits is required` |
| `out` not an array, or an entry that is not a string | `step N: out must be an array of pin names` |
| pin in `out` invalid                    | `step N: invalid pin "<name>" in out` |
| `out_bits` not an integer               | `step N: out_bits must be an integer` |
| `out_bits` negative or above `0xffffffff` | `step N: out_bits must be between 0 and 0xffffffff` |
| `out_bits` outside `VALID_DIO_MASK`     | `step N: out_bits 0x<value, 8 hex digits> has bits outside VALID_DIO_MASK` |
| `hold` missing                          | `step N: hold is required` |
| `hold` not an integer                   | `step N: hold must be an integer` |
| `ns` hold not a multiple of 200         | `step N: hold <value> ns is not a multiple of 200 ns` |
| tick count above `u32::MAX`             | `step N: hold <value> <unit> exceeds the u32 tick range` |
| tick count below 1 (zero or negative hold) | `step N: hold must be at least 1 tick` |

Checks within a step run in the order of the table above (the first failing check
is reported); steps are checked in file order. For a map, the checks of one pin
run in the order of the map table above (pin name, pin is a table, unknown keys,
`dir`, `invert`, then the direction-specific checks).

### `safety.toml`

`N` in `exclusive group N` is the 1-based position of the `[[exclusive]]` entry.

| Condition                               | Message |
|-----------------------------------------|---------|
| `watchdog` not a table                  | `watchdog must be a table` |
| unknown key in `watchdog`               | `unknown key "<key>" in watchdog` |
| `timeout_ms` not an integer             | `watchdog.timeout_ms must be an integer` |
| `timeout_ms` neither `0` nor in `100..=10000` (negative included) | `watchdog.timeout_ms must be 0 or between 100 and 10000` |
| `usb` not a table                       | `usb must be a table` |
| unknown key in `usb`                    | `unknown key "<key>" in usb` |
| `safe` not a boolean                    | `usb.safe must be a boolean` |
| `exclusive` present but not an array of tables | `exclusive must be an array of tables` |
| more than 16 groups                     | `too many exclusive groups: <count> (at most 16)` |
| group entry not a table                 | `exclusive group N: must be a table` |
| unknown key in a group                  | `unknown key "<key>" in exclusive group N` |
| `pins` absent                           | `exclusive group N: pins is required` |
| `pins` not an array, or an entry that is not a string | `exclusive group N: pins must be an array of pin names` |
| pin not in `VALID_DIO_MASK` (also lower case, `GP00`, `GP+5`, ...) | `exclusive group N: invalid pin "<name>" in pins` |
| same pin twice in one group             | `exclusive group N: duplicate pin "<name>" in pins` |
| fewer than 2 pins (empty list included) | `exclusive group N: a group needs at least 2 pins` |

Checks run in the order of the table: `watchdog`, then `usb`, then `exclusive`
(its type, then the group count, then the groups in file order). Within a group
the order is: entry is a table, unknown keys, `pins` present, `pins` shape, then
each pin in file order (invalid, then duplicate), then the pin count. The group
count is checked before any group, so a file with 17 groups is always reported as
`too many exclusive groups` even if one group is also faulty.

## 5. Fixtures

[`docs/fixtures/`](fixtures/) is the shared conformance set. Each file begins
with comment lines that state the expected outcome; the format is deliberately
trivial so any language can read it:

| Comment line | Used in | Meaning |
|--------------|---------|---------|
| `# expected: dir=0x... pull_up=0x... pull_down=0x... out_default=0x... out_polarity=0x... in_polarity=0x... edge=0x...` | valid `map-*.toml` | Exact evaluated masks (8 hex digits each). |
| `# expected: watchdog_ms=<n> usbsafe=<0\|1> groups=0x...,0x...` | valid `safety-*.toml` | Evaluated settings; `groups` lists one 8-hex-digit mask per `[[exclusive]]` in file order, or `none`. |
| `# expected_command: <command line>` | valid `safety-*.toml` | One line per command of the apply sequence of section 7, in order (`excl set 0xc 0x18` / `excl clear`, `usbsafe on\|off`, `wdog <ms>`). Masks are lower-case hex without padding, as in `protocol-reference.md`. |
| `# expected_step: out_bits=0x... hold_ticks=N` | valid `pattern-*.toml` | One line per step, in order. |
| `# expected_error: <message>` | invalid files | The exact error message (section 4), without the `<file>:<line>: ` prefix. |
| `# expected_error_prefix: <text>` | `*-toml-syntax.toml` | The message must start with this text (the rest is parser specific). |
| `# expected_line: N` | invalid files | The 1-based line the error is reported on (section 1). |

Fixture names starting with `map-` are map files, `pattern-` are pattern files,
`safety-` are `safety.toml` files.
Every message of section 4 has at least one fixture; the boundary values
(`u32::MAX` ticks, `VALID_DIO_MASK`) have positive fixtures.

| Fixture | Kind | Covers |
|---------|------|--------|
| `map-all-output.toml` | valid | All 25 pins as outputs |
| `map-bad-dir.toml` | invalid | error `GP0: dir must be "in" or "out"` |
| `map-bad-edge.toml` | invalid | error `GP4: edge must be a boolean` |
| `map-bad-invert.toml` | invalid | error `GP0: invert must be a boolean` |
| `map-bad-pull.toml` | invalid | error `GP4: pull must be "up", "down" or "none"` |
| `map-default-not-bit.toml` | invalid | error `GP0: default must be 0 or 1` |
| `map-default-on-input.toml` | invalid | error `GP1: default is only allowed on an output pin` |
| `map-default.toml` | valid | Empty `[pins]` = default map |
| `map-edge-on-output.toml` | invalid | error `GP6: edge is not allowed on an output pin` |
| `map-invalid-pin-leading-zero.toml` | invalid | error `invalid pin GP00: valid pins are GP0-GP22, GP26, GP27` |
| `map-invalid-pin-lowercase.toml` | invalid | error `invalid pin gp1: valid pins are GP0-GP22, GP26, GP27` |
| `map-invalid-pin-plus-sign.toml` | invalid | error `invalid pin GP+5: valid pins are GP0-GP22, GP26, GP27` |
| `map-invalid-pin.toml` | invalid | error `invalid pin GP23: valid pins are GP0-GP22, GP26, GP27` |
| `map-invalid-version.toml` | invalid | error `unsupported version: expected 2, got 1` |
| `map-missing-version.toml` | invalid | error `missing key "version"` |
| `map-mixed-io.toml` | valid | out/in mix, `default`, `invert`, `pull`, `edge = false`, GP26 |
| `map-out-with-pull.toml` | invalid | error `GP5: pull is not allowed on an output pin` |
| `map-pin-not-table.toml` | invalid | error `GP0: pin must be a table` |
| `map-pin-tables.toml` | valid | `[pins.GPn]` sub-table form and `GP3 = {}` |
| `map-pins-not-table.toml` | invalid | error `pins must be a table` |
| `map-pull-conflict.toml` | invalid | error `GP4: pull must be "up", "down" or "none"` |
| `map-toml-syntax.toml` | invalid | error `toml syntax:` |
| `map-unknown-key.toml` | invalid | error `unknown key "pul" in GP2` |
| `map-unknown-top-key.toml` | invalid | error `unknown key "pin"` |
| `map-version-before-unknown-key.toml` | invalid | error `unsupported version: expected 2, got 1` |
| `map-version-not-integer.toml` | invalid | error `version must be an integer` |
| `pattern-bad-unit.toml` | invalid | error `invalid unit "ms": expected "tick", "ns" or "us"` |
| `pattern-basic.toml` | valid | `unit = "tick"`, `out` and `out_bits` |
| `pattern-hold-missing.toml` | invalid | error `step 1: hold is required` |
| `pattern-hold-not-integer.toml` | invalid | error `step 1: hold must be an integer` |
| `pattern-invalid-pin-in-out.toml` | invalid | error `step 1: invalid pin "GP23" in out` |
| `pattern-invalid-pin-leading-zero.toml` | invalid | error `step 1: invalid pin "GP05" in out` |
| `pattern-missing-out.toml` | invalid | error `step 1: one of out or out_bits is required` |
| `pattern-missing-version.toml` | invalid | error `missing key "version"` |
| `pattern-negative-hold.toml` | invalid | error `step 1: hold must be at least 1 tick` |
| `pattern-no-steps.toml` | invalid | error `pattern has no steps` |
| `pattern-ns-not-multiple.toml` | invalid | error `step 1: hold 250 ns is not a multiple of 200 ns` |
| `pattern-ns.toml` | valid | `unit = "ns"` conversion |
| `pattern-out-bits-max.toml` | valid | `out_bits = VALID_DIO_MASK`, default unit |
| `pattern-out-bits-negative.toml` | invalid | error `step 1: out_bits must be between 0 and 0xffffffff` |
| `pattern-out-bits-not-integer.toml` | invalid | error `step 1: out_bits must be an integer` |
| `pattern-out-bits-outside-mask.toml` | invalid | error `step 2: out_bits 0x00800000 has bits outside VALID_DIO_MASK` |
| `pattern-out-bits-too-wide.toml` | invalid | error `step 1: out_bits must be between 0 and 0xffffffff` |
| `pattern-out-conflict.toml` | invalid | error `step 1: out and out_bits are mutually exclusive` |
| `pattern-out-entry-not-string.toml` | invalid | error `step 1: out must be an array of pin names` |
| `pattern-out-not-array.toml` | invalid | error `step 1: out must be an array of pin names` |
| `pattern-step-not-table.toml` | invalid | error `step 1: step must be a table` |
| `pattern-step-not-array.toml` | invalid | error `step must be an array of tables` |
| `pattern-tick-max.toml` | valid | Largest and smallest `tick` hold |
| `pattern-tick-overflow.toml` | invalid | error `step 1: hold 4294967296 tick exceeds the u32 tick range` |
| `pattern-toml-syntax.toml` | invalid | error `toml syntax:` |
| `pattern-unit-not-string.toml` | invalid | error `unit must be a string` |
| `pattern-unknown-step-key.toml` | invalid | error `unknown key "holdd" in step 1` |
| `pattern-unknown-top-key.toml` | invalid | error `unknown key "loop"` |
| `pattern-us-max.toml` | valid | Largest `us` hold: 858993459 us = 4294967295 ticks |
| `pattern-us-overflow.toml` | invalid | error `step 1: hold 858993460 us exceeds the u32 tick range` |
| `pattern-zero-hold.toml` | invalid | error `step 1: hold must be at least 1 tick` |
| `safety-empty-tables.toml` | valid | Empty `[watchdog]`, `[usb]` and `exclusive = []` = everything off |
| `safety-exclusive-not-array.toml` | invalid | error `exclusive must be an array of tables` |
| `safety-full.toml` | valid | Watchdog 800, `usb.safe`, two overlapping groups |
| `safety-group-empty.toml` | invalid | error `exclusive group 1: a group needs at least 2 pins` |
| `safety-group-not-table.toml` | invalid | error `exclusive group 1: must be a table` |
| `safety-group-one-pin.toml` | invalid | error `exclusive group 2: a group needs at least 2 pins` |
| `safety-group-pins-entry-not-string.toml` | invalid | error `exclusive group 1: pins must be an array of pin names` |
| `safety-group-pins-missing.toml` | invalid | error `exclusive group 1: pins is required` |
| `safety-group-pins-not-array.toml` | invalid | error `exclusive group 1: pins must be an array of pin names` |
| `safety-groups-max.toml` | valid | The maximum of 16 groups |
| `safety-inline-bad-timeout.toml` | invalid | error `watchdog.timeout_ms must be 0 or between 100 and 10000` |
| `safety-inline-tables.toml` | valid | Inline-table spellings |
| `safety-invalid-pin-lowercase.toml` | invalid | error `exclusive group 2: invalid pin "gp3" in pins` |
| `safety-invalid-version.toml` | invalid | error `unsupported version: expected 2, got 1` |
| `safety-minimal.toml` | valid | Only `version`: all off, `excl clear` / `usbsafe off` / `wdog 0` |
| `safety-missing-version.toml` | invalid | error `missing key "version"` |
| `safety-pin-duplicate.toml` | invalid | error `exclusive group 1: duplicate pin "GP2" in pins` |
| `safety-pin-not-output.toml` | invalid | error `exclusive group 1: invalid pin "GP25" in pins` |
| `safety-pin-out-of-range.toml` | invalid | error `exclusive group 1: invalid pin "GP28" in pins` |
| `safety-pins-high.toml` | valid | GP22, GP26, GP27 in groups |
| `safety-toml-syntax.toml` | invalid | error `toml syntax:` |
| `safety-too-many-groups.toml` | invalid | error `too many exclusive groups: 17 (at most 16)` |
| `safety-unknown-group-key.toml` | invalid | error `unknown key "name" in exclusive group 1` |
| `safety-unknown-top-key.toml` | invalid | error `unknown key "watchdgo"` |
| `safety-unknown-usb-key.toml` | invalid | error `unknown key "safe_mode" in usb` |
| `safety-unknown-watchdog-key.toml` | invalid | error `unknown key "timeout" in watchdog` |
| `safety-usb-not-table.toml` | invalid | error `usb must be a table` |
| `safety-usb-safe-not-boolean.toml` | invalid | error `usb.safe must be a boolean` |
| `safety-version-before-unknown-key.toml` | invalid | error `unsupported version: expected 2, got 1` |
| `safety-version-not-integer.toml` | invalid | error `version must be an integer` |
| `safety-watchdog-max.toml` | valid | `timeout_ms = 10000` |
| `safety-watchdog-min.toml` | valid | `timeout_ms = 100` |
| `safety-watchdog-negative.toml` | invalid | error `watchdog.timeout_ms must be 0 or between 100 and 10000` |
| `safety-watchdog-not-table.toml` | invalid | error `watchdog must be a table` |
| `safety-watchdog-timeout-not-integer.toml` | invalid | error `watchdog.timeout_ms must be an integer` |
| `safety-watchdog-too-large.toml` | invalid | error `watchdog.timeout_ms must be 0 or between 100 and 10000` |
| `safety-watchdog-too-small.toml` | invalid | error `watchdog.timeout_ms must be 0 or between 100 and 10000` |
| `safety-watchdog-zero.toml` | valid | `timeout_ms = 0` and `safe = false` |

`sdk/rust/tests/toml_v2_fixtures.rs` evaluates every fixture with a small
reference evaluator of this document and compares message and line to the
comments. It also reads this file: every message template in section 4 must be
produced by at least one fixture, every fixture error must match a documented
template, every fixture must appear in the table above, and the
`VALID_DIO_MASK` defined in section 1 must equal the constant in the test. The
schema text, the messages and the fixtures therefore cannot drift apart
silently.

For the `safety-*` fixtures the evaluator also checks the apply sequence: the
commands derived from the evaluated settings must equal the `# expected_command:`
lines (so the order of section 7 cannot change silently).

The fixtures are distributed to `pochi-cli` and `pochi-vscode` by
`scripts/sync-protocol-golden.sh` in the `pochi` parent repository
(`<repo>/protocol/fixtures/`). Edit them **only here**; run
`scripts/sync-protocol-golden.sh --check` to detect stale copies.

## 6. Open decisions (owner sign-off required)

These were chosen by the implementer, not taken from REF-V2 section 4.3. Other
parsers must not copy them until each is approved or changed (the fixtures then
change with them):

1. **Defaults**: `unit` = `"tick"`, pin `dir` = `"in"`, pull = `"down"`,
   `edge` = `true`, output `default` = `0`, `invert` = `false`.
2. **Hold range**: a hold must be at least 1 tick (0 and negative are errors).
3. **Pin-name grammar**: canonical `GP(0|[1-9][0-9]*)`, case-sensitive.
4. **Error message texts** in section 4 and the `<file>:<line>: ` format
   (including the line conventions of section 1).
5. **Check order** of section 1 (version before unknown keys).
6. `pull = "none"` (floating input) as a third pull value.
7. **`safety.toml` error message texts** (section 4) and its line conventions
   (section 1), including the check order of section 4 (the group count before
   any group) and the position wording `exclusive group N`.
8. **Pin rules of `safety.toml`** (**approved**): a duplicate pin is an error
   only inside one group (groups may overlap, as on the device); "not an output
   pin" at file level means "not usable as DIO" (`invalid pin`), because
   whether a valid pin is an output depends on the active map (section 7). The
   file-level fixture is `safety-pin-not-output.toml` (GP25). The device-side
   refusal of a valid pin that is not an output (`ERR BAD_PARAM`) is covered by
   the firmware golden, not by a host fixture.
9. **Apply semantics of `safety.toml`**: the file is a complete declaration, so
   every apply sends `excl set`/`excl clear`, `usbsafe` and `wdog` even for
   absent sections (absent = off / none / `0`).
10. **Watchdog range** `0` or `100..=10000` is the device range
    (`protocol-reference.md`); the file rejects anything else before sending.

## 7. `safety.toml`

Declares the **volatile** safety settings of the device: the watchdog, the
USB-loss behaviour (`usbsafe`) and the exclusive output groups. All three are
reset by every restart of the device and are never stored in flash.

```toml
version = 2

[watchdog]
timeout_ms = 800          # 0 or absent = disabled; enabled: 100..=10000

[usb]
safe = true               # usbsafe on (default: off)

[[exclusive]]
pins = ["GP2", "GP3"]     # at least 2 output pins; at most one may be ON

[[exclusive]]
pins = ["GP4", "GP5", "GP6"]
```

### Separation from `map.toml` (DD-11)

`safety.toml` is a separate file; the keys above are **not** accepted in
`map.toml` (an unknown-key error there), and map keys are not accepted here. The
map is persistent (it can be saved to flash); the safety settings are not.
Keeping them in different files means a user can tell which file survives a
power cycle. `map.toml` rejects unknown keys, so merging the formats would also
break every existing `map.toml` parser.

### Keys

| Key                    | Type                | Required | Default | Meaning |
|------------------------|---------------------|----------|---------|---------|
| `version`              | integer             | yes      | -       | Must be `2`. |
| `watchdog`             | table               | no       | empty   | Watchdog settings. |
| `watchdog.timeout_ms`  | integer             | no       | `0`     | `0` disables the watchdog; otherwise `100..=10000` (`wdog <ms>`). |
| `usb`                  | table               | no       | empty   | USB-loss behaviour. |
| `usb.safe`             | boolean             | no       | `false` | `true` = `usbsafe on`, `false` = `usbsafe off`. |
| `exclusive`            | array of tables (`[[exclusive]]`) | no | none | 0 to 16 exclusive groups. |
| `exclusive.pins`       | array of pin names  | yes (per group) | - | 2 or more distinct pins; at most one of them may be ON. |

Pin names follow section 1. Groups may overlap (the same pin in several groups).
A pin may appear only once inside one group. The order of the groups in the file
is the order in which the device reports them (`excl get`). An absent table, an
empty table and `exclusive = []` mean the same: disabled / off / no groups.

The evaluated settings are `watchdog_ms`, `usbsafe` and one mask per group (bit
`n` = `GPn`, a subset of `VALID_DIO_MASK`); fixtures state them as
`# expected: ...`.

### Output pins are checked by the device

A file by itself is valid when every pin is a usable DIO pin (section 1). That
every pin of a group is an **output** depends on the `dir` of the map active on
the device, which a file cannot know. The device checks it when the groups are
applied and answers `ERR BAD_PARAM` (the previous groups stay); the apply stops
there (below). Hosts that know the map should report this before sending. This is
a property of the device state, so it has no fixture (compare the upload-time
check of section 3).

### Applying (DD-16)

Applying makes the device equal to the file. The commands are sent in this order
and nothing else:

| Step | Command                                   | Notes |
|------|-------------------------------------------|-------|
| 1    | `excl set <mask>...` (one mask per group), or `excl clear` when the file has no groups | `excl set` replaces all groups atomically. **Never send `excl clear` first**: if `excl set` then failed, the device would be left with no groups, which is less safe than before. |
| 2    | `usbsafe on` or `usbsafe off`             | |
| 3    | `wdog <ms>` (`wdog 0` when disabled)      | Last, so the watchdog cannot trip while the other settings are still being sent. |

The first error answered by the device stops the apply: later commands are not
sent, and the error (with its original code, e.g. `BAD_PARAM`, `BUSY`,
`TRANSPORT_NOT_SUPPORTED`) is reported. Commands already accepted stay in effect;
there is no rollback, so the host reads the state back with `safety` and
`excl get` after an error as well. After a successful apply, the read-back must
match the file: `wdog_ms`, `usbsafe` and `excl` of `safety`, and the masks of
`excl get` in file order.

The commands are CDC only. They need a map with the pins already configured as
outputs: apply `map.toml` first. While groups exist the device refuses
`map default`, and a `map set` that turns a pin of a group into an input
(`ERR BAD_MAP`); changing the map that way afterwards needs `excl clear` (which
removes the protection) and a new apply of `safety.toml`.

### Watchdog and the host

The watchdog trips when the device receives no `OK` for `timeout_ms`. Whoever
enables it must keep sending commands (the SDKs provide a heartbeat helper that
sends every `timeout_ms / 4`, at most 1 s). A one-shot command-line run that
enables the watchdog and exits trips the device `timeout_ms` later; use the
continuous mode of the CLI. Choose a timeout comfortably above the time of the
longest flash operation (`map save`, `devnum`), during which the device does not
answer, plus the heartbeat period.
