# Configuration files: `map.toml` and `pattern.toml` (schema v2)

Canonical definition of the two host-side TOML formats. Every implementation
(Rust / TypeScript / Python / C# SDKs, `pochi-cli`, the GUI and the VSCode
extension) must accept exactly this schema and reject everything else with the
errors listed in section 4. Conformance is checked against the fixtures in
[`docs/fixtures/`](fixtures/) (section 5).

> **Status: draft pending owner sign-off.** The schema shape follows REF-V2
> section 4.3. The defaults, the pin-name grammar and the error message texts
> below were written by the implementer and are listed in section 6; do not copy
> them into another parser until they are approved.

Requirement: **R-TOML1** — `version` other than 2, unknown keys and
contradictory settings are errors. There is no lenient mode and no migration
of older layouts.

## 1. Common rules

- Both files start with `version = 2` (integer). Missing `version` or any other
  value is an error.
- Any key not listed in this document is an error, at every level (top level,
  pin table, step table). Keys are case-sensitive.
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
  4. The remaining top-level keys, then the pins (map) or the steps in file
     order (pattern), each in the order of the tables in section 4.

  For several faulty pins in one map file, which pin is reported first is
  implementation-defined (the fixtures contain one fault each).
- The `flags` word of the device PinMap is reserved and always sent as 0. It is
  not a file key; `flags = ...` is an unknown-key error.

### `VALID_DIO_MASK = 0x0c7fffff`

Bit `n` corresponds to `GPn`. The mask covers bits 0-22 (GP0-GP22) and bits
26-27 (GP26, GP27). GP23, GP24, GP25 (on-board LED) and GP28 are not usable as
DIO. Any pin outside the mask is an error in `map.toml` and `pattern.toml`.
Every mask field produced from these files (`dir`, `pull_up`, `pull_down`,
`out_default`, `out_polarity`, `in_polarity`, `edge`, and each step's
`out_bits`) is a subset of `VALID_DIO_MASK`.

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
| `default`| integer `0` or `1`         | output     | `0`      | Level driven when the map is applied (before polarity). |
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

### Both files

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

## 5. Fixtures

[`docs/fixtures/`](fixtures/) is the shared conformance set. Each file begins
with comment lines that state the expected outcome; the format is deliberately
trivial so any language can read it:

| Comment line | Used in | Meaning |
|--------------|---------|---------|
| `# expected: dir=0x... pull_up=0x... pull_down=0x... out_default=0x... out_polarity=0x... in_polarity=0x... edge=0x...` | valid `map-*.toml` | Exact evaluated masks (8 hex digits each). |
| `# expected_step: out_bits=0x... hold_ticks=N` | valid `pattern-*.toml` | One line per step, in order. |
| `# expected_error: <message>` | invalid files | The exact error message (section 4), without the `<file>:<line>: ` prefix. |
| `# expected_error_prefix: <text>` | `*-toml-syntax.toml` | The message must start with this text (the rest is parser specific). |
| `# expected_line: N` | invalid files | The 1-based line the error is reported on (section 1). |

Fixture names starting with `map-` are map files, `pattern-` are pattern files.
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

`sdk/rust/tests/toml_v2_fixtures.rs` evaluates every fixture with a small
reference evaluator of this document and compares message and line to the
comments. It also reads this file: every message template in section 4 must be
produced by at least one fixture, every fixture error must match a documented
template, every fixture must appear in the table above, and the
`VALID_DIO_MASK` defined in section 1 must equal the constant in the test. The
schema text, the messages and the fixtures therefore cannot drift apart
silently.

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
