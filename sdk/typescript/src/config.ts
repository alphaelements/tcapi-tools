/**
 * Parser for the host-side `safety.toml` (schema v2, `docs/config-files.md`
 * section 7, R-TOML1/R-TOML2). Mirrors `sdk/rust/src/config.rs`
 * (`parse_safety` / `load_safety`); applying the result is
 * `Connection.applySafety`.
 *
 * There is no lenient mode: a `version` other than 2, an unknown key or a
 * contradictory setting is an error, and every error names the file and the
 * 1-based line of the offending element (`<file>:<line>: <message>`). The
 * message texts are the ones of section 4 of the document; the shared fixtures
 * in `docs/fixtures/` pin them down for every implementation.
 *
 * Exactly one error is reported: the first failing check, in the order the
 * document defines (syntax, `version`, unknown top-level keys, then
 * `watchdog`, `usb` and `exclusive`).
 */

import { readFile } from "node:fs/promises";
import { ErrorCode, SdkError } from "./errors.js";
import { TomlSyntaxError, parseToml, type TomlNode, type TomlTable } from "./toml.js";
import {
  MAX_EXCLUSIVE_GROUPS,
  PROTO_VERSION,
  VALID_DIO_MASK,
  WDOG_MAX_MS,
  WDOG_MIN_MS,
  type SafetyConfig,
} from "./types.js";

/**
 * A rejected configuration file. `code` is `ErrorCode.Parse`; `message` is
 * `<file>:<line>: <reason>`.
 */
export class ConfigError extends SdkError {
  /** Name of the file as given to the parser (used in the message only). */
  readonly file: string;
  /** 1-based line of the offending element. */
  readonly line: number;
  /** The message of `docs/config-files.md` section 4, without the prefix. */
  readonly reason: string;

  constructor(file: string, line: number, reason: string) {
    super(ErrorCode.Parse, `${file}:${line}: ${reason}`);
    this.name = "ConfigError";
    this.file = file;
    this.line = line;
    this.reason = reason;
  }
}

/** An error before the file name is attached. */
class Fail extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
  ) {
    super(reason);
  }
}

/**
 * Parse the text of a `safety.toml` into the settings it declares: the
 * watchdog timeout, `usbsafe` and one pin mask per exclusive group. `file`
 * only labels errors.
 */
export function parseSafety(src: string, file: string): SafetyConfig {
  try {
    return evalSafety(src);
  } catch (err) {
    if (err instanceof Fail) throw new ConfigError(file, err.line, err.reason);
    throw err;
  }
}

/** Read and parse a `safety.toml`. Errors carry the path of the file; an unreadable file is `Io`. */
export async function loadSafety(path: string): Promise<SafetyConfig> {
  let src: string;
  try {
    src = await readFile(path, "utf8");
  } catch (err) {
    throw new SdkError(
      ErrorCode.Io,
      `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseSafety(src, path);
}

// ------------------------------------------------------------------ helpers

/** Whole-file errors (missing `version`) are reported on line 1. */
const FILE_LINE = 1;

/** Canonical pin name grammar: `GP(0|[1-9][0-9]*)` whose number is in `VALID_DIO_MASK`. */
function pinNumber(name: string): number | undefined {
  const m = /^GP(0|[1-9][0-9]*)$/.exec(name);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return n < 32 && ((VALID_DIO_MASK >>> n) & 1) === 1 ? n : undefined;
}

/** The keys of a table in the order the checks visit them: sorted, like the Rust reference. */
function sortedKeys(table: TomlTable): string[] {
  return [...table.entries.keys()].sort();
}

function checkKeys(table: TomlTable, allowed: readonly string[], context: string): void {
  for (const key of sortedKeys(table)) {
    if (!allowed.includes(key)) {
      throw new Fail(`unknown key "${key}"${context}`, (table.entries.get(key) as TomlNode).line);
    }
  }
}

function checkVersion(root: TomlTable): void {
  const version = root.entries.get("version");
  if (version === undefined) throw new Fail('missing key "version"', FILE_LINE);
  if (version.type !== "integer") throw new Fail("version must be an integer", version.line);
  if (version.value !== BigInt(PROTO_VERSION)) {
    throw new Fail(`unsupported version: expected ${PROTO_VERSION}, got ${version.value}`, version.line);
  }
}

// ------------------------------------------------------------------- safety

function evalWatchdog(root: TomlTable): number {
  const watchdog = root.entries.get("watchdog");
  if (watchdog === undefined) return 0;
  if (watchdog.type !== "table") throw new Fail("watchdog must be a table", watchdog.line);
  checkKeys(watchdog, ["timeout_ms"], " in watchdog");
  const timeout = watchdog.entries.get("timeout_ms");
  if (timeout === undefined) return 0;
  if (timeout.type !== "integer") throw new Fail("watchdog.timeout_ms must be an integer", timeout.line);
  const ms = timeout.value;
  if (ms !== 0n && (ms < BigInt(WDOG_MIN_MS) || ms > BigInt(WDOG_MAX_MS))) {
    throw new Fail(
      `watchdog.timeout_ms must be 0 or between ${WDOG_MIN_MS} and ${WDOG_MAX_MS}`,
      timeout.line,
    );
  }
  return Number(ms);
}

function evalUsb(root: TomlTable): boolean {
  const usb = root.entries.get("usb");
  if (usb === undefined) return false;
  if (usb.type !== "table") throw new Fail("usb must be a table", usb.line);
  checkKeys(usb, ["safe"], " in usb");
  const safe = usb.entries.get("safe");
  if (safe === undefined) return false;
  if (safe.type !== "boolean") throw new Fail("usb.safe must be a boolean", safe.line);
  return safe.value;
}

/** The pin mask of exclusive group `n` (1-based). */
function evalGroup(n: number, group: TomlNode): number {
  if (group.type !== "table") throw new Fail(`exclusive group ${n}: must be a table`, group.line);
  checkKeys(group, ["pins"], ` in exclusive group ${n}`);
  const pins = group.entries.get("pins");
  if (pins === undefined) throw new Fail(`exclusive group ${n}: pins is required`, group.line);
  const notNames = (): Fail =>
    new Fail(`exclusive group ${n}: pins must be an array of pin names`, pins.line);
  if (pins.type !== "array") throw notNames();
  let mask = 0;
  let count = 0;
  for (const pin of pins.items) {
    if (pin.type !== "string") throw notNames();
    const bit = pinNumber(pin.value);
    if (bit === undefined) {
      throw new Fail(`exclusive group ${n}: invalid pin "${pin.value}" in pins`, pins.line);
    }
    if (((mask >>> bit) & 1) === 1) {
      throw new Fail(`exclusive group ${n}: duplicate pin "${pin.value}" in pins`, pins.line);
    }
    mask = (mask | (1 << bit)) >>> 0;
    count++;
  }
  if (count < 2) throw new Fail(`exclusive group ${n}: a group needs at least 2 pins`, pins.line);
  return mask;
}

function evalGroups(root: TomlTable): number[] {
  const exclusive = root.entries.get("exclusive");
  if (exclusive === undefined) return [];
  if (exclusive.type !== "array") {
    throw new Fail("exclusive must be an array of tables", exclusive.line);
  }
  // Checked before any group, so 17 groups are always reported as too many even
  // if one of them is also faulty.
  if (exclusive.items.length > MAX_EXCLUSIVE_GROUPS) {
    throw new Fail(
      `too many exclusive groups: ${exclusive.items.length} (at most ${MAX_EXCLUSIVE_GROUPS})`,
      exclusive.items[MAX_EXCLUSIVE_GROUPS].line,
    );
  }
  return exclusive.items.map((group, i) => evalGroup(i + 1, group));
}

function evalSafety(src: string): SafetyConfig {
  let root: TomlTable;
  try {
    root = parseToml(src);
  } catch (err) {
    if (err instanceof TomlSyntaxError) throw new Fail(`toml syntax: ${err.message}`, err.line);
    throw err;
  }
  checkVersion(root);
  checkKeys(root, ["version", "watchdog", "usb", "exclusive"], "");
  const watchdogMs = evalWatchdog(root);
  const usbsafe = evalUsb(root);
  const groups = evalGroups(root);
  return { watchdogMs, usbsafe, groups };
}
