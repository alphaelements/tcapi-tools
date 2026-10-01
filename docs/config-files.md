# Configuration files: `map.toml` and `pattern.toml` (schema v2)

Canonical definition of the two host-side TOML formats. Every implementation
(Rust / TypeScript / Python / C# SDKs, `pochi-cli`, the GUI and the VSCode
extension) must accept exactly this schema and reject everything else with the
errors listed in section 4. Conformance is checked against the fixtures in
[`docs/fixtures/`](fixtures/) (section 5).

Requirement: **R-TOML1** — `version` other than 2, unknown keys and
contradictory settings are errors. There is no lenient mode and no migration
of older layouts.

## 1. Common rules

- Both files start with `version = 2` (integer). Missing `version` or any other
  value is an error.
- Any key not listed in this document is an error, at every level (top level,
  pin table, step table). Keys are case-sensitive.
- Pin names are `GP<n>` for `n` in `0-22, 26, 27`. These are exactly the bits
  of `VALID_DIO_MASK`.
- Error messages are part of the contract (the fixtures pin them). Implementations
  may prefix location information (file name, line) but the message text after it
  must match.

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

## 4. Errors

Position `N` in `step N` is 1-based. `<value>` placeholders are replaced by the
offending input. All of these are hard errors; nothing is applied to the device.

### Both files

| Condition                         | Message |
|-----------------------------------|---------|
| `version` missing                 | `missing key "version"` |
| `version` not an integer          | `version must be an integer` |
| `version` is an integer other than 2 | `unsupported version: expected 2, got <value>` |
| unknown top-level key             | `unknown key "<key>"` |
| TOML syntax error                 | `toml syntax: <parser message>` |

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
| no `[[step]]`                           | `pattern has no steps` |
| step not a table                        | `step N: step must be a table` |
| unknown step key                        | `unknown key "<key>" in step N` |
| both `out` and `out_bits`               | `step N: out and out_bits are mutually exclusive` |
| neither `out` nor `out_bits`            | `step N: one of out or out_bits is required` |
| `out` not an array                      | `step N: out must be an array of pin names` |
| pin in `out` invalid                    | `step N: invalid pin "<name>" in out` |
| `out_bits` not an integer               | `step N: out_bits must be an integer` |
| `out_bits` outside `VALID_DIO_MASK`     | `step N: out_bits 0x<value, 8 hex digits> has bits outside VALID_DIO_MASK` |
| `hold` missing                          | `step N: hold is required` |
| `hold` not an integer                   | `step N: hold must be an integer` |
| `ns` hold not a multiple of 200         | `step N: hold <value> ns is not a multiple of 200 ns` |
| tick count above `u32::MAX`             | `step N: hold <value> <unit> exceeds the u32 tick range` |
| tick count below 1 (zero or negative hold) | `step N: hold must be at least 1 tick` |

Checks within a step run in the order of the table above (the first failing check
is reported); steps are checked in file order.

## 5. Fixtures

[`docs/fixtures/`](fixtures/) is the shared conformance set. Each file begins
with comment lines that state the expected outcome; the format is deliberately
trivial so any language can read it:

| Comment line | Used in | Meaning |
|--------------|---------|---------|
| `# expected: dir=0x... pull_up=0x... pull_down=0x... out_default=0x... out_polarity=0x... in_polarity=0x... edge=0x...` | valid `map-*.toml` | Exact evaluated masks (8 hex digits each). |
| `# expected_step: out_bits=0x... hold_ticks=N` | valid `pattern-*.toml` | One line per step, in order. |
| `# expected_error: <message>` | invalid files | The exact error message (section 4), without any location prefix. |

| Fixture                          | Kind    | Covers |
|----------------------------------|---------|--------|
| `map-default.toml`               | valid   | Empty `[pins]` = default map |
| `map-mixed-io.toml`              | valid   | out/in mix, `default`, `invert`, `pull`, `edge = false`, GP26 |
| `map-all-output.toml`            | valid   | All 25 pins as outputs |
| `pattern-basic.toml`             | valid   | `unit = "tick"`, `out` and `out_bits` |
| `pattern-ns.toml`                | valid   | `unit = "ns"` conversion |
| `map-invalid-version.toml`       | invalid | `version = 1` |
| `map-pull-conflict.toml`         | invalid | Pull-up + pull-down together |
| `map-out-with-pull.toml`         | invalid | `pull` on an output |
| `map-edge-on-output.toml`        | invalid | `edge` on an output |
| `map-unknown-key.toml`           | invalid | Unknown pin key |
| `map-invalid-pin.toml`           | invalid | GP23 outside `VALID_DIO_MASK` |
| `pattern-bad-unit.toml`          | invalid | Unknown `unit` |
| `pattern-ns-not-multiple.toml`   | invalid | `ns` not a multiple of 200 |
| `pattern-us-overflow.toml`       | invalid | `us` overflowing `u32` ticks |
| `pattern-out-conflict.toml`      | invalid | `out` together with `out_bits` |
| `pattern-zero-hold.toml`         | invalid | `hold = 0` |

`sdk/rust/tests/toml_v2_fixtures.rs` evaluates every fixture with a small
reference evaluator of this document and compares the result to the comments, so
the schema text, the messages and the fixtures cannot drift apart silently.

The fixtures are distributed to `pochi-cli` and `pochi-vscode` by
`scripts/sync-protocol-golden.sh` in the `pochi` parent repository
(`<repo>/protocol/fixtures/`). Edit them **only here**; run
`scripts/sync-protocol-golden.sh --check` to detect stale copies.
