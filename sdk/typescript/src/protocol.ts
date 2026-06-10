/**
 * Command builders and typed response parsers for the CDC text protocol.
 * Pure functions (no I/O) — every parser is unit-testable without a
 * device. Mirrors `sdk/rust/src/protocol.rs`.
 */

import { SdkError } from "./errors.js";
import { asIsNs } from "./reconcile.js";
import type {
  Capabilities,
  EdgeMode,
  IoState,
  PatternMode,
  PatternState,
  PatternStatus,
  PatternStep,
  PinMap,
  PullMode,
  PushEvent,
  TimestampEvent,
  VersionInfo,
} from "./types.js";

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

/** Extract the data of an `ok` response, mapping `err` codes to typed errors. */
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

/** Extract `count=N` from an OK data string (`ts get` / `sync count`). */
export function parseCountField(okDataStr: string): number {
  const part = okDataStr.split(/\s+/).find((p) => p.startsWith("count="));
  if (!part) throw SdkError.parse(`missing count= field: ${okDataStr}`);
  const value = Number(part.slice(6));
  if (!Number.isInteger(value) || value < 0) {
    throw SdkError.parse(`invalid count= value: ${okDataStr}`);
  }
  return value;
}

function parseU32(s: string): number {
  if (!/^(0[xX][0-9a-fA-F]+|\d+)$/.test(s)) {
    throw SdkError.parse(`invalid number: ${s}`);
  }
  const value = Number(s);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw SdkError.parse(`invalid number: ${s}`);
  }
  return value;
}

function fields(data: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of data.split(/\s+/)) {
    const idx = part.indexOf("=");
    if (idx > 0) map.set(part.slice(0, idx), part.slice(idx + 1));
  }
  return map;
}

function requireField(map: Map<string, string>, key: string, ctx: string): string {
  const value = map.get(key);
  if (value === undefined) {
    throw SdkError.parse(`missing ${key}= field in ${ctx}`);
  }
  return value;
}

function parseIntStrict(s: string, ctx: string): number {
  if (!/^\d+$/.test(s)) throw SdkError.parse(`invalid number in ${ctx}: ${s}`);
  return Number(s);
}

// --- version ---

/** Parse `v0.1.0 proto=1`. */
export function parseVersion(data: string): VersionInfo {
  const verPart = data.split(/\s+/).find((p) => /^v\d+\.\d+\.\d+$/.test(p));
  if (!verPart) throw SdkError.parse(`missing version in: ${data}`);
  const [major, minor, patch] = verPart.slice(1).split(".").map(Number);
  const proto = fields(data).get("proto");
  if (proto === undefined) throw SdkError.parse(`missing proto= in: ${data}`);
  return {
    major,
    minor,
    patch,
    protocolVersion: parseIntStrict(proto, "version"),
  };
}

// --- caps ---

/**
 * Parse `dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x...`.
 * Old firmware (`ts_res=1000`) fails loudly as UnsupportedFirmware.
 */
export function parseCaps(data: string): Capabilities {
  const f = fields(data);
  const ctx = `caps: ${data}`;
  const tsRes = parseIntStrict(
    requireField(f, "ts_res", ctx).replace(/ns$/, ""),
    ctx,
  );
  const caps: Capabilities = {
    protocolVersion: 0, // populated by the caller from `version`
    maxDio: parseIntStrict(requireField(f, "dio", ctx), ctx),
    outCount: parseIntStrict(requireField(f, "out", ctx), ctx),
    inCount: parseIntStrict(requireField(f, "in", ctx), ctx),
    tsResolutionNs: tsRes,
    maxPatternSteps: parseIntStrict(requireField(f, "pattern", ctx), ctx),
    tsRingEvents: parseIntStrict(requireField(f, "ring", ctx), ctx),
    features: parseU32(requireField(f, "feat", ctx)),
  };
  if (caps.tsResolutionNs === 1000) {
    throw SdkError.unsupportedFirmware(
      "caps reports ts_res=1000ns (pre-Phase 9.6 timestamp format)",
    );
  }
  return caps;
}

// --- info ---

/** Parse `uid=AABBCCDD11223344 devnum=42`. devnum 255 maps to null. */
export function parseInfo(data: string): { uid: string; deviceNumber: number | null } {
  const f = fields(data);
  const uid = f.get("uid");
  if (!uid) throw SdkError.parse(`missing uid in info response: ${data}`);
  let deviceNumber: number | null = null;
  const devnum = f.get("devnum");
  if (devnum !== undefined) {
    const n = parseIntStrict(devnum, `info: ${data}`);
    deviceNumber = n === 255 ? null : n;
  }
  return { uid, deviceNumber };
}

// --- map ---

/** Parse `v=1 out=0:12 in=12:11 pull=up flags=0x01`. */
export function parseMap(data: string): PinMap {
  const f = fields(data);
  const ctx = `map: ${data}`;
  const range = (key: string): [number, number] => {
    const value = requireField(f, key, ctx);
    const idx = value.indexOf(":");
    if (idx < 0) throw SdkError.parse(`invalid ${key}= range in ${ctx}`);
    return [
      parseIntStrict(value.slice(0, idx), ctx),
      parseIntStrict(value.slice(idx + 1), ctx),
    ];
  };
  const [outBase, outCount] = range("out");
  const [inBase, inCount] = range("in");
  const pull = requireField(f, "pull", ctx);
  if (pull !== "none" && pull !== "up" && pull !== "down") {
    throw SdkError.parse(`invalid pull mode in map: ${pull}`);
  }
  return {
    version: parseIntStrict(requireField(f, "v", ctx), ctx),
    outBase,
    outCount,
    inBase,
    inCount,
    pull: pull as PullMode,
    flags: parseU32(requireField(f, "flags", ctx)),
  };
}

/**
 * Encode a PinMap as the 48-char hex string for `map set`. Extended
 * fields not in PinMap (out_default, polarities) are zero.
 */
export function mapToHex(map: PinMap): string {
  const buf = new Uint8Array(24);
  buf[0] = map.version;
  buf[1] = map.outBase;
  buf[2] = map.outCount;
  buf[3] = map.inBase;
  buf[4] = map.inCount;
  buf[5] = map.pull === "none" ? 0 : map.pull === "up" ? 1 : 2;
  buf[6] = map.flags;
  return Buffer.from(buf).toString("hex");
}

// --- read / write / state ---

/** Parse the `read` response data: `0x000005`. */
export function parseRead(data: string): number {
  return parseU32(data.trim());
}

/** Parse `in=0x000005 out=0x00000A flags=0x00`. */
export function parseState(data: string): IoState {
  const f = fields(data);
  const ctx = `state: ${data}`;
  return {
    inputs: parseU32(requireField(f, "in", ctx)),
    outputs: parseU32(requireField(f, "out", ctx)),
    flags: parseU32(requireField(f, "flags", ctx)),
  };
}

// --- pattern ---

/**
 * Encode pattern steps for `pattern load`: step count (u16 LE) followed
 * by 8 bytes per step (out_bits u32 LE + hold_us u32 LE), hex-encoded.
 */
export function patternToHex(steps: PatternStep[]): string {
  if (steps.length === 0) {
    throw SdkError.parse("pattern must have at least one step");
  }
  if (steps.length > 0xffff) {
    throw SdkError.parse(`too many pattern steps: ${steps.length}`);
  }
  const buf = Buffer.alloc(2 + steps.length * 8);
  buf.writeUInt16LE(steps.length, 0);
  steps.forEach((step, i) => {
    buf.writeUInt32LE(step.outBits >>> 0, 2 + i * 8);
    buf.writeUInt32LE(step.holdUs >>> 0, 6 + i * 8);
  });
  return buf.toString("hex");
}

/** Parse `accepted=4` from the `pattern load` response. */
export function parseAccepted(data: string): number {
  const part = data.split(/\s+/).find((p) => p.startsWith("accepted="));
  if (!part) throw SdkError.parse(`missing accepted= field: ${data}`);
  return parseIntStrict(part.slice(9), `accepted: ${data}`);
}

/** Build the `pattern run` command string. */
export function patternRunCommand(mode: PatternMode, repeat: number): string {
  return mode === "once" ? "pattern run once 1" : `pattern run loop ${repeat}`;
}

/** Parse `state=running step=5 loops=3`. */
export function parsePatternStatus(data: string): PatternStatus {
  const f = fields(data);
  const ctx = `pattern status: ${data}`;
  const state = requireField(f, "state", ctx);
  if (!["idle", "loaded", "running", "done"].includes(state)) {
    throw SdkError.parse(`unknown pattern state: ${state}`);
  }
  return {
    state: state as PatternState,
    currentStep: parseIntStrict(requireField(f, "step", ctx), ctx),
    loopsDone: parseIntStrict(requireField(f, "loops", ctx), ctx),
  };
}

// --- timestamp ---

/** Build the `ts arm` command string. */
export function tsArmCommand(mask: number, mode: EdgeMode): string {
  return `ts arm 0x${(mask >>> 0).toString(16)} ${mode}`;
}

/**
 * Parse one `ts get` event line (FW Phase 9.6): `0x00000005 c=1000 p=7 s=1`.
 * The pre-9.6 `t=` format is rejected as UnsupportedFirmware — never
 * parsed silently.
 */
export function parseTsEventLine(line: string): TimestampEvent {
  const trimmed = line.trim();
  const parts = trimmed.split(/\s+/);
  const inputsPart = parts.find((p) => p.startsWith("0x") || p.startsWith("0X"));
  const f = fields(trimmed);

  if (f.has("t") && !f.has("c")) {
    throw SdkError.unsupportedFirmware(
      `ts event uses pre-Phase 9.6 \`t=\` format: ${trimmed}`,
    );
  }
  if (!inputsPart) {
    throw SdkError.parse(`missing inputs (0x...) field in ts event: ${trimmed}`);
  }
  const ctx = `ts event: ${trimmed}`;
  const rawCount = parseIntStrict(requireField(f, "c", ctx), ctx);
  const rawPhase = parseIntStrict(requireField(f, "p", ctx), ctx);
  const s = requireField(f, "s", ctx);
  if (s !== "0" && s !== "1") {
    throw SdkError.parse(`invalid s= in ts event: ${s}`);
  }
  return {
    inputs: parseU32(inputsPart),
    rawCount,
    rawPhase,
    syncActive: s === "1",
    timestampNs: asIsNs(rawCount, rawPhase),
  };
}

// --- sync ---

/** Parse the `sync count` response data: `count=1000000`. */
export function parseSyncCount(data: string): number {
  return parseCountField(data);
}

// --- push events ---

/**
 * Parse the payload of a push line (after `! `). Unknown event types are
 * preserved as `{ type: "unknown" }` rather than dropped.
 */
export function parsePushEvent(payload: string): PushEvent {
  const trimmed = payload.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const kind = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx < 0 ? "" : trimmed.slice(spaceIdx + 1);
  const f = fields(rest);

  switch (kind) {
    case "INPUT": {
      const inputsPart = rest
        .split(/\s+/)
        .find((p) => p.startsWith("0x") || p.startsWith("0X"));
      if (!inputsPart) {
        throw SdkError.parse(`missing inputs (0x...) in INPUT event: ${trimmed}`);
      }
      const t = f.get("t");
      if (t === undefined || !/^\d+$/.test(t)) {
        throw SdkError.parse(`missing or invalid t= in INPUT event: ${trimmed}`);
      }
      return { type: "input_change", inputs: parseU32(inputsPart), timestampUs: Number(t) };
    }
    case "PATTERN_DONE": {
      const loops = f.get("loops");
      if (loops === undefined || !/^\d+$/.test(loops)) {
        throw SdkError.parse(`missing or invalid loops= in PATTERN_DONE event: ${trimmed}`);
      }
      return { type: "pattern_done", loops: Number(loops) };
    }
    case "SYNC_DONE": {
      const status = f.get("status");
      const devnum = f.get("devnum");
      const ts = f.get("ts");
      if (
        status === undefined ||
        devnum === undefined ||
        !/^\d+$/.test(devnum) ||
        ts === undefined ||
        !/^\d+$/.test(ts)
      ) {
        throw SdkError.parse(`missing field in SYNC_DONE event: ${trimmed}`);
      }
      return { type: "sync_done", status, devnum: Number(devnum), timestamp: Number(ts) };
    }
    default:
      return { type: "unknown", raw: trimmed };
  }
}
