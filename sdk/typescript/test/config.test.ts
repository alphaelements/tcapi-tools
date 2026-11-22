/**
 * `safety.toml` parser against every shared fixture in `docs/fixtures/`
 * (R-TOML1/R-TOML2): the evaluated settings, the apply commands, the exact
 * error message and the reported line must equal the fixture's `# expected*`
 * comments. Mirrors `sdk/rust/tests/config_fixtures.rs` (the `safety-*` part).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadSafety, parseSafety } from "../src/config.js";
import { ErrorCode, SdkError } from "../src/errors.js";
import { safetyConfigCommands } from "../src/protocol.js";
import type { SafetyConfig } from "../src/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/fixtures");

function fixtureNames(): string[] {
  const names = readdirSync(FIXTURES)
    .filter((n) => n.endsWith(".toml"))
    .sort();
  expect(names.length, "fixture set looks truncated").toBeGreaterThanOrEqual(50);
  return names;
}

function annotations(src: string, key: string): string[] {
  const prefix = `# ${key}:`;
  return src
    .split("\n")
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length).trim());
}

/** `watchdog_ms=800 usbsafe=1 groups=0x0000000c,0x00000018` in the fixture's `# expected:` form. */
function summary(c: SafetyConfig): string {
  const groups =
    c.groups.length === 0
      ? "none"
      : c.groups.map((m) => `0x${m.toString(16).padStart(8, "0")}`).join(",");
  return `watchdog_ms=${c.watchdogMs} usbsafe=${c.usbsafe ? 1 : 0} groups=${groups}`;
}

function expectError(name: string, src: string, err: unknown): void {
  expect(err, name).toBeInstanceOf(ConfigError);
  const e = err as ConfigError;
  const exact = annotations(src, "expected_error");
  const prefix = annotations(src, "expected_error_prefix");
  expect(exact.length + prefix.length, `${name}: one error annotation only`).toBe(1);
  if (exact.length === 1) expect(e.reason, name).toBe(exact[0]);
  else expect(e.reason.startsWith(prefix[0]), `${name}: ${e.reason}`).toBe(true);
  expect(e.line, `${name}: line`).toBe(Number(annotations(src, "expected_line")[0]));
  expect(e.file).toBe(name);
  expect(e.message).toBe(`${name}:${e.line}: ${e.reason}`);
  expect(e.code).toBe(ErrorCode.Parse);
}

describe("safety fixtures", () => {
  const safety = fixtureNames().filter((n) => n.startsWith("safety-"));

  it("covers the whole shared set", () => {
    expect(safety.length).toBeGreaterThanOrEqual(38);
    // Every fixture is a map, pattern or safety file: a new family needs a parser here.
    for (const n of fixtureNames()) {
      expect(/^(map|pattern|safety)-/.test(n), n).toBe(true);
    }
  });

  it.each(safety)("%s gives the documented result", (name) => {
    const src = readFileSync(join(FIXTURES, name), "utf8");
    const hasError =
      annotations(src, "expected_error").length + annotations(src, "expected_error_prefix").length > 0;
    let cfg: SafetyConfig;
    try {
      cfg = parseSafety(src, name);
    } catch (err) {
      expect(hasError, `${name}: unexpected error ${String(err)}`).toBe(true);
      expectError(name, src, err);
      return;
    }
    expect(hasError, `${name}: expected an error, parsing succeeded`).toBe(false);
    expect(annotations(src, "expected"), name).toEqual([summary(cfg)]);
    // DD-16: the apply order of the evaluated file.
    expect(safetyConfigCommands(cfg), `${name}: apply commands`).toEqual(annotations(src, "expected_command"));
  });

  it("has both valid and invalid files", () => {
    let valid = 0;
    let invalid = 0;
    for (const name of safety) {
      try {
        parseSafety(readFileSync(join(FIXTURES, name), "utf8"), name);
        valid++;
      } catch {
        invalid++;
      }
    }
    expect(valid).toBeGreaterThanOrEqual(9);
    expect(invalid).toBeGreaterThanOrEqual(29);
  });
});

describe("parseSafety", () => {
  it("defaults are all off", () => {
    expect(parseSafety("version = 2\n", "s.toml")).toEqual({ watchdogMs: 0, usbsafe: false, groups: [] });
  });

  it("rejects map keys", () => {
    const err = catchConfig(() => parseSafety("version = 2\n[pins]\n", "s.toml"));
    expect([err.reason, err.line]).toEqual(['unknown key "pins"', 2]);
  });

  it("negative: empty input and garbage are errors, not defaults", () => {
    const empty = catchConfig(() => parseSafety("", "s.toml"));
    expect([empty.reason, empty.line]).toEqual(['missing key "version"', 1]);
    const garbage = catchConfig(() => parseSafety("version = 2\nwatchdog = \n", "s.toml"));
    expect(garbage.reason.startsWith("toml syntax: ")).toBe(true);
    expect(garbage.line).toBe(2);
  });

  it("group masks follow the pin names", () => {
    const cfg = parseSafety('version = 2\n[[exclusive]]\npins = ["GP26", "GP0", "GP27"]\n', "s.toml");
    expect(cfg.groups).toEqual([1 + (1 << 26) + (1 << 27)]);
  });

  it("GP27 and GP22 reach the top bits without sign trouble", () => {
    const cfg = parseSafety('version = 2\n[[exclusive]]\npins = ["GP27", "GP26"]\n', "s.toml");
    expect(cfg.groups).toEqual([0x0c000000]);
  });

  it("CRLF line endings give the same result and lines", () => {
    const src = 'version = 2\r\n\r\n[watchdog]\r\ntimeout_ms = 99\r\n';
    const err = catchConfig(() => parseSafety(src, "s.toml"));
    expect([err.reason, err.line]).toEqual(["watchdog.timeout_ms must be 0 or between 100 and 10000", 4]);
  });

  it("a float or a huge integer timeout is not silently rounded", () => {
    const float = catchConfig(() => parseSafety("version = 2\n[watchdog]\ntimeout_ms = 800.0\n", "s.toml"));
    expect(float.reason).toBe("watchdog.timeout_ms must be an integer");
    const huge = catchConfig(() =>
      parseSafety("version = 2\n[watchdog]\ntimeout_ms = 4294967396\n", "s.toml"),
    );
    expect(huge.reason).toBe("watchdog.timeout_ms must be 0 or between 100 and 10000");
  });

  it("an unknown key is reported alphabetically first when there are several", () => {
    const err = catchConfig(() => parseSafety("version = 2\nzeta = 1\nalpha = 2\n", "s.toml"));
    expect(err.reason).toBe('unknown key "alpha"');
    expect(err.line).toBe(3);
  });

  it("the version check comes before the syntax-independent key checks", () => {
    const err = catchConfig(() => parseSafety("version = 3\nbogus = 1\n", "s.toml"));
    expect(err.reason).toBe("unsupported version: expected 2, got 3");
  });

  it("dotted keys and quoted keys are the same table as the section spelling", () => {
    const dotted = parseSafety("version = 2\nwatchdog.timeout_ms = 250\nusb.safe = true\n", "s.toml");
    expect(dotted).toEqual({ watchdogMs: 250, usbsafe: true, groups: [] });
    const quoted = parseSafety('version = 2\n"watchdog" = { "timeout_ms" = 250 }\n', "s.toml");
    expect(quoted.watchdogMs).toBe(250);
  });

  it("a multi-line inline array of group tables reports on the line of the key", () => {
    const src = 'version = 2\nexclusive = [\n  { pins = ["GP1", "GP2"] },\n  { pins = ["GP3"] },\n]\n';
    const err = catchConfig(() => parseSafety(src, "s.toml"));
    expect([err.reason, err.line]).toEqual(["exclusive group 2: a group needs at least 2 pins", 2]);
  });

  it("negative: a repeated key and a redefined table are syntax errors", () => {
    expect(catchConfig(() => parseSafety("version = 2\nversion = 2\n", "s.toml")).reason).toMatch(/^toml syntax: /);
    const redefined = catchConfig(() => parseSafety("version = 2\n[usb]\nsafe = true\n[usb]\n", "s.toml"));
    expect(redefined.reason).toMatch(/^toml syntax: /);
    expect(redefined.line).toBe(4);
  });
});

function catchConfig(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

describe("loadSafety", () => {
  it("reads files and names them in errors", async () => {
    const cfg = await loadSafety(join(FIXTURES, "safety-full.toml"));
    expect(cfg.watchdogMs).toBe(800);
    const bad = join(FIXTURES, "safety-pin-duplicate.toml");
    const err = await loadSafety(bad).then(
      () => undefined,
      (e: unknown) => e as SdkError,
    );
    expect(err?.code).toBe(ErrorCode.Parse);
    expect(err?.message).toContain(`${bad}:7:`);
  });

  it("a missing file is an Io error, not a default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcapi-safety-"));
    try {
      const err = await loadSafety(join(dir, "no-such-file.toml")).then(
        () => undefined,
        (e: unknown) => e as SdkError,
      );
      expect(err).toBeInstanceOf(SdkError);
      expect(err?.code).toBe(ErrorCode.Io);
      expect(err?.message).toContain("no-such-file.toml");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("reads a file written by the caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcapi-safety-"));
    try {
      const path = join(dir, "safety.toml");
      writeFileSync(path, 'version = 2\n[usb]\nsafe = true\n');
      expect(await loadSafety(path)).toEqual({ watchdogMs: 0, usbsafe: true, groups: [] });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
