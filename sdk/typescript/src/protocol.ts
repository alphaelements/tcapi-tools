/**
 * Command builders and typed response parsers for the v2 CDC text protocol.
 * Pure functions (no I/O) — every parser is unit-testable without a device.
 * Mirrors `sdk/rust/src/protocol.rs`.
 *
 * Parsers are strict (R-P6): a response must carry exactly the documented
 * keys, no more and no fewer, and numbers must be in range. Anything else is
 * an `SdkError` with code `Parse`, never a silently defaulted value.
 */

import { SdkError } from "./errors.js";
import {
  PROTO_VERSION,
  checkDioMask,
  patternStepToText,
  pinMapToSetArgs,
  validatePinMap,
  type Capabilities,
  type EdgeMode,
  type IoState,
  type PatternMode,
  type PatternState,
  type PatternStatus,
  type PatternStep,
  type PinMap,
  type PushEvent,
  type TimestampEvent,
  type TsStatus,
  type VersionInfo,
} from "./types.js";

/** Longest request line the device accepts, excluding the CR/LF terminator (R-T1). */
export const MAX_LINE_BYTES = 256;

/** Most events one `ts get` response carries (the device clamps larger values). */
export const MAX_TS_GET_EVENTS = 85;

/** Highest valid `p=` (raw phase) value of a timestamp event. */
const MAX_RAW_PHASE = 24;

const U8_MAX = 0xff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/** A single response line, classified. */
export type Response =
  | { kind: "ok"; data: string }
  | { kind: "err"; code: string }
  | { kind: "push"; payload: string };

/** Classify one response line. Trailing CR/LF is tolerated. */
export function parseResponse(line: string): Response {
  const trimmed = line.replace(/[\r\n]+$/, "");
  if (trimmed === "OK") return { kind: "ok", data: "" };
  if (trimmed.startsWith("OK ")) return { kind: "ok", data: trimmed.slice(3) };
  if (trimmed.startsWith("ERR ")) return { kind: "err", code: trimmed.slice(4) };
  if (trimmed.startsWith("! ")) return { kind: "push", payload: trimmed.slice(2) };
  throw SdkError.parse(`unexpected response line: ${trimmed}`);
}

/** Extract the data of an `ok` response, mapping `err` names to typed errors. */
export function okData(response: Response): string {
  switch (response.kind) {
    case "ok":
      return response.data;
    case "err":
      throw SdkError.fromErrorCode(response.code);
    case "push":
      throw SdkError.parse(
        `unexpected push event in response position: ! ${response.payload}`,
      );
  }
}

/**
 * Extract `count=N` from the header of a counted multi-line response
 * (`ts get`, `help`). Returns `null` when the response carries no `count=`
 * (a single-line response); an invalid value is a parse error.
 */
export function parseCountField(okDataStr: string): number | null {
  const part = okDataStr.split(/\s+/).find((p) => p.startsWith("count="));
  if (part === undefined) return null;
  const value = part.slice("count=".length);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw SdkError.parse(`invalid count= value: ${okDataStr}`);
  }
  return Number(value);
}

// --- key=value field parsing ---

/**
 * The `key=value` fields of one response, checked against the exact key set
 * the protocol documents for it.
 */
class Fields {
  private readonly pairs = new Map<string, string>();

  /**
   * Split `data` into `key=value` tokens. Every key in `keys` must be present
   * exactly once and no other key may appear (order is free).
   */
  constructor(
    private readonly ctx: string,
    private readonly data: string,
    keys: readonly string[],
  ) {
    for (const token of data.split(/\s+/).filter((t) => t.length > 0)) {
      const idx = token.indexOf("=");
      if (idx < 0) throw this.error(`token without '=' (${token})`);
      const key = token.slice(0, idx);
      if (!keys.includes(key)) throw this.error(`unexpected key ${key}=`);
      if (this.pairs.has(key)) throw this.error(`duplicate key ${key}=`);
      this.pairs.set(key, token.slice(idx + 1));
    }
    const missing = keys.find((k) => !this.pairs.has(k));
    if (missing !== undefined) throw this.error(`missing ${missing}= field`);
  }

  private error(msg: string): SdkError {
    return SdkError.parse(`${msg} in ${this.ctx}: ${this.data}`);
  }

  private invalid(key: string): SdkError {
    return SdkError.parse(`invalid ${key}= value in ${this.ctx}: ${this.data}`);
  }

  raw(key: string): string {
    const value = this.pairs.get(key);
    if (value === undefined) throw this.invalid(key);
    return value;
  }

  /** Plain decimal integer in `0..=max`. */
  dec(key: string, max: number = Number.MAX_SAFE_INTEGER): number {
    const raw = this.raw(key);
    if (!/^\d+$/.test(raw)) throw this.invalid(key);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > max) throw this.invalid(key);
    return value;
  }

  /** Mask or bit value: `0x` hex (canonical) or decimal, as a u32. */
  mask(key: string): number {
    const raw = this.raw(key);
    const ok = /^0[xX][0-9a-fA-F]+$/.test(raw) || /^\d+$/.test(raw);
    const value = ok ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value > U32_MAX) throw this.invalid(key);
    return value;
  }

  /** `0` or `1`. */
  flag(key: string): boolean {
    switch (this.raw(key)) {
      case "0":
        return false;
      case "1":
        return true;
      default:
        throw this.invalid(key);
    }
  }
}

// --- version ---

/**
 * Parse `fw=0.1.3 proto=2`. The protocol number is returned as reported;
 * callers decide whether it is supported (`PROTO_VERSION`).
 */
export function parseVersion(data: string): VersionInfo {
  const f = new Fields("version", data, ["fw", "proto"]);
  const fw = f.raw("fw");
  const nums = fw.split(".");
  if (nums.length !== 3 || !nums.every((n) => /^\d+$/.test(n) && Number(n) <= U8_MAX)) {
    throw SdkError.parse(`invalid fw= value in version: ${data}`);
  }
  const [major, minor, patch] = nums.map(Number);
  return { major, minor, patch, protocolVersion: f.dec("proto", U8_MAX) };
}

/**
 * Fail with UnsupportedFirmware unless the device speaks the one protocol this
 * SDK is built for (`proto=2`).
 */
export function assertSupportedProtocol(version: VersionInfo): void {
  if (version.protocolVersion !== PROTO_VERSION) {
    throw SdkError.unsupportedFirmware(
      `unsupported protocol proto=${version.protocolVersion} (this SDK speaks proto=${PROTO_VERSION})`,
    );
  }
}

// --- caps ---

/**
 * Parse `dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=256 ring=256
 * feat=0x00000003`.
 */
export function parseCaps(data: string): Capabilities {
  const f = new Fields("caps", data, [
    "dio",
    "out",
    "in",
    "ts_res_ns",
    "tick_ns",
    "pattern",
    "ring",
    "feat",
  ]);
  return {
    dio: f.dec("dio", U8_MAX),
    out: f.dec("out", U8_MAX),
    in: f.dec("in", U8_MAX),
    tsResNs: f.dec("ts_res_ns", U32_MAX),
    tickNs: f.dec("tick_ns", U32_MAX),
    patternMax: f.dec("pattern", U16_MAX),
    ring: f.dec("ring", U16_MAX),
    features: f.mask("feat"),
  };
}

// --- info / ping ---

/** Parse `uid=0123456789ABCDEF devnum=42`. devnum 255 (unassigned) maps to `null`. */
export function parseInfo(data: string): { uid: string; deviceNumber: number | null } {
  const f = new Fields("info", data, ["uid", "devnum"]);
  const uid = f.raw("uid");
  if (!/^[0-9a-fA-F]{16}$/.test(uid)) {
    throw SdkError.parse(`invalid uid= value in info: ${data}`);
  }
  const devnum = f.dec("devnum", U8_MAX);
  return { uid, deviceNumber: devnum === 255 ? null : devnum };
}

/** Parse the `ping` response `pong=<u32>`. */
export function parsePong(data: string): number {
  return new Fields("ping", data, ["pong"]).dec("pong", U32_MAX);
}

// --- map ---

/**
 * Parse the `map get` response `v=2 flags=0x00 dir=... edge=...` and validate
 * it (R-M1): a device reporting an invalid or non-v2 map is an error, not a
 * value.
 */
export function parseMap(data: string): PinMap {
  const f = new Fields("map", data, [
    "v",
    "flags",
    "dir",
    "pu",
    "pd",
    "def",
    "opol",
    "ipol",
    "edge",
  ]);
  const version = f.dec("v", U8_MAX);
  if (version !== PROTO_VERSION) {
    throw SdkError.parse(`unsupported map version v=${version} in map: ${data}`);
  }
  const flags = f.mask("flags");
  if (flags > U8_MAX) throw SdkError.parse(`invalid flags= value in map: ${data}`);
  const map: PinMap = {
    flags,
    direction: f.mask("dir"),
    pullUp: f.mask("pu"),
    pullDown: f.mask("pd"),
    outDefault: f.mask("def"),
    outPolarity: f.mask("opol"),
    inPolarity: f.mask("ipol"),
    edge: f.mask("edge"),
  };
  try {
    validatePinMap(map);
  } catch (err) {
    throw SdkError.parse(
      `device reported an invalid map (${err instanceof Error ? err.message : err}): ${data}`,
    );
  }
  return map;
}

/** Build the `map set` command for `map` (validated first). */
export function mapSetCommand(map: PinMap): string {
  return `map set ${pinMapToSetArgs(map)}`;
}

// --- read / write / state ---

/** Parse the `read` response `in=0x00000005`. */
export function parseRead(data: string): number {
  return new Fields("read", data, ["in"]).mask("in");
}

/** Parse the `state` response `in=0x00000000 out=0x00000005`. */
export function parseState(data: string): IoState {
  const f = new Fields("state", data, ["in", "out"]);
  return { inputs: f.mask("in"), outputs: f.mask("out") };
}

/**
 * Build the `write <values> <mask>` command. The mask must stay within the DIO
 * pins (R-PIN2); value bits outside the mask are ignored by the device (golden
 * io.txt), so `values` only has to be a u32.
 */
export function writeCommand(values: number, mask: number): string {
  if (!Number.isInteger(values) || values < 0 || values > U32_MAX) {
    throw SdkError.invalidArgument(`write values ${values} is not an unsigned 32-bit integer`);
  }
  checkDioMask("write mask", mask);
  return `write 0x${values.toString(16)} 0x${mask.toString(16)}`;
}

// --- pattern ---

/**
 * Build the `pattern add` command lines for `steps`. Steps are packed
 * greedily so every line stays within `MAX_LINE_BYTES`; each line is applied
 * atomically by the device (R-PT3). Every step is validated first, so nothing
 * is produced for a bad pattern.
 */
export function patternAddCommands(steps: readonly PatternStep[]): string[] {
  if (steps.length === 0) {
    throw SdkError.invalidArgument("pattern must have at least one step");
  }
  const prefix = "pattern add";
  const texts = steps.map(patternStepToText);
  const lines: string[] = [];
  let line = prefix;
  for (const text of texts) {
    // +1 for the separating space.
    if (line.length + 1 + text.length > MAX_LINE_BYTES) {
      lines.push(line);
      line = prefix;
    }
    line += ` ${text}`;
  }
  lines.push(line);
  return lines;
}

/** Parse the `pattern add` response `total=<n>`: steps now in the buffer. */
export function parsePatternTotal(data: string): number {
  return new Fields("pattern add", data, ["total"]).dec("total", U16_MAX);
}

/**
 * Build the `pattern run` command string. `once` plays one pass (the repeat is
 * ignored); `loop` requires a repeat of 1-65535.
 */
export function patternRunCommand(mode: PatternMode, repeat: number): string {
  if (mode === "once") return "pattern run once";
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > U16_MAX) {
    throw SdkError.invalidArgument(`loop repeat ${repeat} is outside 1-${U16_MAX}`);
  }
  return `pattern run loop ${repeat}`;
}

const PATTERN_STATES: readonly PatternState[] = ["idle", "loaded", "running", "done"];

/** Parse `state=running step=5 loops=3 total=40`. */
export function parsePatternStatus(data: string): PatternStatus {
  const f = new Fields("pattern status", data, ["state", "step", "loops", "total"]);
  const state = PATTERN_STATES.find((s) => s === f.raw("state"));
  if (state === undefined) throw SdkError.parse(`unknown pattern state: ${f.raw("state")}`);
  return {
    state,
    step: f.dec("step", U16_MAX),
    loops: f.dec("loops", U16_MAX),
    total: f.dec("total", U16_MAX),
  };
}

// --- timestamp ---

/** Build the `ts arm` command: a non-zero mask within the DIO pins (R-PIN2). */
export function tsArmCommand(mask: number, mode: EdgeMode): string {
  checkDioMask("ts arm mask", mask);
  if (mask === 0) throw SdkError.invalidArgument("ts arm mask must not be 0");
  return `ts arm 0x${mask.toString(16)} ${mode}`;
}

/** Build the `ts get <max>` command; `max` is 1-85 (R-TS3). */
export function tsGetCommand(maxEvents: number): string {
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_TS_GET_EVENTS) {
    throw SdkError.invalidArgument(`ts get max ${maxEvents} is outside 1-${MAX_TS_GET_EVENTS}`);
  }
  return `ts get ${maxEvents}`;
}

/** Parse the `ts status` response `armed=1 pending=2 overflow=0`. */
export function parseTsStatus(data: string): TsStatus {
  const f = new Fields("ts status", data, ["armed", "pending", "overflow"]);
  return {
    armed: f.flag("armed"),
    pending: f.dec("pending", U32_MAX),
    overflow: f.flag("overflow"),
  };
}

/**
 * Parse the header of a `ts get` response, `count=3 overflow=0`, into the
 * number of event lines that follow and the ring-overflow flag.
 */
export function parseTsGetHeader(data: string): { count: number; overflow: boolean } {
  const f = new Fields("ts get", data, ["count", "overflow"]);
  return { count: f.dec("count", U32_MAX), overflow: f.flag("overflow") };
}

/**
 * Parse one `ts get` event line: `in=0x00000001 c=1000 p=7 s=1` (surrounding
 * whitespace, including the two leading spaces of a continuation line, is
 * ignored).
 */
export function parseTsEventLine(line: string): TimestampEvent {
  const f = new Fields("ts event", line.trim(), ["in", "c", "p", "s"]);
  return {
    inputs: f.mask("in"),
    rawCount: f.dec("c", U32_MAX),
    rawPhase: f.dec("p", MAX_RAW_PHASE),
    syncActive: f.flag("s"),
  };
}

// --- sync ---

/** Parse the `sync count` response `clocks=1000000`. */
export function parseSyncCount(data: string): number {
  return new Fields("sync count", data, ["clocks"]).dec("clocks");
}

// --- push events ---

/** A push line of a name this SDK does not know. */
export interface UnknownPushEvent {
  type: "unknown";
  raw: string;
}

/**
 * Parse the payload of a push line (after `! `). A recognized event with
 * malformed fields is an error. Unknown event names are returned as
 * `{ type: "unknown" }` so the caller decides how to surface them (the
 * transport logs and discards them).
 */
export function parsePushEvent(payload: string): PushEvent | UnknownPushEvent {
  const trimmed = payload.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const kind = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx < 0 ? "" : trimmed.slice(spaceIdx + 1);

  switch (kind) {
    case "INPUT": {
      const f = new Fields("INPUT event", rest, ["in", "t"]);
      return { type: "input_change", inputs: f.mask("in"), timestampUs: f.dec("t") };
    }
    case "PATTERN_DONE":
      return {
        type: "pattern_done",
        loops: new Fields("PATTERN_DONE event", rest, ["loops"]).dec("loops", U16_MAX),
      };
    case "PATTERN_TIMEOUT":
      return {
        type: "pattern_timeout",
        loops: new Fields("PATTERN_TIMEOUT event", rest, ["loops"]).dec("loops", U16_MAX),
      };
    default:
      return { type: "unknown", raw: trimmed };
  }
}
