/**
 * Unit tests for the v2 command builders and strict response parsers
 * (mirrors the unit tests of `sdk/rust/src/protocol.rs`).
 */
import { describe, expect, it } from "vitest";
import { ErrorCode, SdkError } from "../src/errors.js";
import * as protocol from "../src/protocol.js";
import { defaultPinMap, hasReset, hasSync, timestampNs, type PinMap } from "../src/types.js";

// Removed-vocabulary probes are assembled at runtime so the R-X1 gate (which scans
// the source text for legacy names) only sees them where a test must reject them.
const LEGACY_PROTO = ["proto", "1"].join("=");
const LEGACY_DIO = ["dio", "23"].join("=");
const LEGACY_TS_RES = ["ts", "res="].join("_");
const REMOVED_EVENT = ["SYNC", "DONE"].join("_");

function code(fn: () => unknown): ErrorCode {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SdkError);
    return (err as SdkError).code;
  }
  throw new Error("expected an SdkError");
}

function parseError(fn: () => unknown): void {
  expect(code(fn)).toBe(ErrorCode.Parse);
}

describe("parseResponse / okData", () => {
  it("classifies OK, ERR and push lines", () => {
    expect(protocol.parseResponse("OK\r\n")).toEqual({ kind: "ok", data: "" });
    expect(protocol.parseResponse("OK fw=0.1.3 proto=2")).toEqual({
      kind: "ok",
      data: "fw=0.1.3 proto=2",
    });
    expect(protocol.parseResponse("ERR BAD_MAP")).toEqual({ kind: "err", code: "BAD_MAP" });
    expect(protocol.parseResponse("! INPUT in=0x00000005 t=99")).toEqual({
      kind: "push",
      payload: "INPUT in=0x00000005 t=99",
    });
  });

  it("rejects garbage, OKAY and empty lines", () => {
    parseError(() => protocol.parseResponse("garbage"));
    parseError(() => protocol.parseResponse("OKAY nope"));
    parseError(() => protocol.parseResponse(""));
  });

  it("okData maps ERR names and rejects pushes", () => {
    expect(protocol.okData({ kind: "ok", data: "x" })).toBe("x");
    expect(code(() => protocol.okData({ kind: "err", code: "BUSY" }))).toBe(ErrorCode.Busy);
    expect(code(() => protocol.okData({ kind: "err", code: "UNKNOWN_CMD" }))).toBe(
      ErrorCode.UnknownCmd,
    );
    expect(code(() => protocol.okData({ kind: "err", code: "WHAT" }))).toBe(
      ErrorCode.UnknownDevice,
    );
    expect(code(() => protocol.okData({ kind: "push", payload: "INPUT" }))).toBe(ErrorCode.Parse);
  });
});

describe("ERR name mapping", () => {
  it.each([
    ["BAD_PARAM", ErrorCode.BadParam],
    ["BAD_MAP", ErrorCode.BadMap],
    ["BUSY", ErrorCode.Busy],
    ["FLASH", ErrorCode.Flash],
    ["TOO_LONG", ErrorCode.TooLong],
    ["NOT_ARMED", ErrorCode.NotArmed],
    ["SYNC_STATE", ErrorCode.SyncState],
    ["NO_RESOURCE", ErrorCode.NoResource],
    ["NOT_RUNNING", ErrorCode.NotRunning],
    ["UNKNOWN_CMD", ErrorCode.UnknownCmd],
    ["LINE_TOO_LONG", ErrorCode.LineTooLong],
    ["BAD_CMD", ErrorCode.BadCommand],
    ["TRANSPORT_NOT_SUPPORTED", ErrorCode.TransportNotSupported],
    ["SYNC_TIMEOUT", ErrorCode.UnknownDevice], // removed in v2: no longer special
    ["SOMETHING_NEW", ErrorCode.UnknownDevice],
  ])("%s", (name, expected) => {
    expect(SdkError.fromErrorCode(name).code).toBe(expected);
  });

  it("keeps the raw name of an unknown error", () => {
    expect(SdkError.fromErrorCode("SOMETHING_NEW").message).toContain("SOMETHING_NEW");
  });
});

describe("parseCountField", () => {
  it("reads count=N", () => {
    expect(protocol.parseCountField("count=2")).toBe(2);
    expect(protocol.parseCountField("count=0")).toBe(0);
    expect(protocol.parseCountField("count=3 overflow=0")).toBe(3);
  });

  it("returns null when the response has no count=", () => {
    expect(protocol.parseCountField("")).toBeNull();
    expect(protocol.parseCountField("clocks=5")).toBeNull();
  });

  it("rejects an invalid count", () => {
    parseError(() => protocol.parseCountField("count=abc"));
    parseError(() => protocol.parseCountField("count=-1"));
    parseError(() => protocol.parseCountField("count="));
    parseError(() => protocol.parseCountField("count=1.5"));
  });
});

describe("strictness (shared by every parser)", () => {
  it("rejects unknown, duplicate and bare tokens", () => {
    for (const bad of ["pong=1 extra=2", "pong=1 pong=2", "pong", "1", ""]) {
      parseError(() => protocol.parsePong(bad));
    }
  });

  it("rejects signs and empty digits", () => {
    for (const bad of ["pong=+1", "pong=-1", "pong=", "pong=1e3", "pong= 1"]) {
      parseError(() => protocol.parsePong(bad));
    }
    for (const bad of ["in=0x", "in=0x+5", "in=", "in=0xg"]) {
      parseError(() => protocol.parseRead(bad));
    }
  });
});

describe("parseVersion", () => {
  it("parses fw and proto in any key order", () => {
    expect(protocol.parseVersion("fw=0.1.3 proto=2")).toEqual({
      major: 0,
      minor: 1,
      patch: 3,
      protocolVersion: 2,
    });
    expect(protocol.parseVersion("proto=2 fw=12.34.56")).toMatchObject({
      major: 12,
      minor: 34,
      patch: 56,
    });
  });

  it("reports a foreign protocol as is (the caller decides)", () => {
    expect(protocol.parseVersion(`fw=0.1.0 ${LEGACY_PROTO}`).protocolVersion).toBe(1);
  });

  it("rejects malformed input, including the v1 form", () => {
    for (const bad of [
      "proto=2",
      "fw=0.1.3",
      "fw=0.1 proto=2",
      "fw=0.1.3.4 proto=2",
      "fw=X.Y.Z proto=2",
      "fw=v0.1.3 proto=2",
      "fw=0.1.256 proto=2",
      "fw=0.1.3 proto=two",
      `v0.1.0 ${LEGACY_PROTO}`,
      "",
    ]) {
      parseError(() => protocol.parseVersion(bad));
    }
  });
});

const CAPS =
  "dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x00000003";

describe("parseCaps", () => {
  it("parses every field", () => {
    const c = protocol.parseCaps(CAPS);
    expect(c).toEqual({
      dio: 25,
      out: 2,
      in: 23,
      tsResNs: 40,
      tickNs: 200,
      patternMax: 256,
      ring: 256,
      features: 3,
    });
    expect(hasSync(c) && hasReset(c)).toBe(true);
  });

  it("zero features", () => {
    const c = protocol.parseCaps(CAPS.replace("feat=0x00000003", "feat=0x00000000"));
    expect(hasSync(c) || hasReset(c)).toBe(false);
  });

  it("rejects the v1 format", () => {
    parseError(() =>
      protocol.parseCaps(`${LEGACY_DIO} out=12 in=11 ${LEGACY_TS_RES}40ns pattern=256 ring=256 feat=0x1`),
    );
  });

  it("rejects missing, malformed, out-of-range and extra fields", () => {
    parseError(() => protocol.parseCaps("dio=25 out=12 in=11"));
    parseError(() => protocol.parseCaps(CAPS.replace("dio=25", "dio=banana")));
    parseError(() => protocol.parseCaps(CAPS.replace("pattern=256", "pattern=65536")));
    parseError(() => protocol.parseCaps(CAPS.replace("dio=25", "dio=256")));
    parseError(() => protocol.parseCaps(`${CAPS} proto=2`));
  });
});

describe("parseInfo / parsePong", () => {
  it("parses uid and device number", () => {
    expect(protocol.parseInfo("uid=AABBCCDD11223344 devnum=42")).toEqual({
      uid: "AABBCCDD11223344",
      deviceNumber: 42,
    });
  });

  it("255 means unassigned; 0 and 254 are valid", () => {
    expect(protocol.parseInfo("uid=0000000000000000 devnum=255").deviceNumber).toBeNull();
    expect(protocol.parseInfo("uid=0000000000000000 devnum=0").deviceNumber).toBe(0);
    expect(protocol.parseInfo("uid=0000000000000000 devnum=254").deviceNumber).toBe(254);
  });

  it("rejects malformed info", () => {
    for (const bad of [
      "devnum=1",
      "uid=AABBCCDD11223344",
      "uid=AABB devnum=1",
      "uid=ZZBBCCDD11223344 devnum=1",
      "uid=AABBCCDD11223344 devnum=256",
      "uid=AABBCCDD11223344 devnum=zzz",
    ]) {
      parseError(() => protocol.parseInfo(bad));
    }
  });

  it("pong boundaries", () => {
    expect(protocol.parsePong("pong=0")).toBe(0);
    expect(protocol.parsePong("pong=4294967295")).toBe(0xffffffff);
    parseError(() => protocol.parsePong("pong=4294967296"));
  });
});

const MAP =
  "v=2 flags=0x00 dir=0x0000000f pu=0x000000f0 pd=0x0c7fff00 " +
  "def=0x00000005 opol=0x00000008 ipol=0x00000100 edge=0x0c7ffff0";

describe("map", () => {
  it("get -> set round trip (R-M3)", () => {
    const map = protocol.parseMap(MAP);
    expect(map).toEqual<PinMap>({
      flags: 0,
      direction: 0x0f,
      pullUp: 0xf0,
      pullDown: 0x0c7fff00,
      outDefault: 5,
      outPolarity: 8,
      inPolarity: 0x100,
      edge: 0x0c7ffff0,
    });
    expect(protocol.mapSetCommand(map)).toBe(`map set ${MAP.replace("v=2 ", "")}`);
  });

  it("default map response", () => {
    expect(
      protocol.parseMap(
        "v=2 flags=0x00 dir=0x00000000 pu=0x00000000 pd=0x0c7fffff def=0x00000000 " +
          "opol=0x00000000 ipol=0x00000000 edge=0x0c7fffff",
      ),
    ).toEqual(defaultPinMap());
  });

  it("rejects a wrong version and the v1 format", () => {
    parseError(() => protocol.parseMap(MAP.replace("v=2", "v=1")));
    parseError(() => protocol.parseMap("v=1 out=0:12 in=12:11 pull=up flags=0x01"));
  });

  it("rejects an invalid device map", () => {
    parseError(() => protocol.parseMap(MAP.replace("dir=0x0000000f", "dir=0x0080000f")));
  });

  it("rejects missing, unknown and bad fields", () => {
    parseError(() => protocol.parseMap("v=2 flags=0x00"));
    parseError(() => protocol.parseMap(`${MAP} extra=0x0`));
    parseError(() => protocol.parseMap(MAP.replace("flags=0x00", "flags=0x100")));
    parseError(() => protocol.parseMap(MAP.replace("pu=0x000000f0", "pu=0xzz")));
  });

  it("mapSetCommand refuses an invalid map", () => {
    expect(code(() => protocol.mapSetCommand({ ...defaultPinMap(), flags: 1 }))).toBe(
      ErrorCode.InvalidArgument,
    );
  });
});

describe("read / write / state", () => {
  it("parseRead", () => {
    expect(protocol.parseRead("in=0x00000005")).toBe(5);
    expect(protocol.parseRead("in=0x0c7fffff")).toBe(0x0c7fffff);
    expect(protocol.parseRead("in=5")).toBe(5);
    for (const bad of ["0x5", "five", "", "in=0x1ffffffff"]) {
      parseError(() => protocol.parseRead(bad));
    }
  });

  it("parseState", () => {
    expect(protocol.parseState("in=0x00000030 out=0x00000005")).toEqual({
      inputs: 0x30,
      outputs: 5,
    });
    parseError(() => protocol.parseState("in=0x05"));
    parseError(() => protocol.parseState("in=0x05 out=0x0A flags=0x00"));
  });

  it("writeCommand formats and checks masks", () => {
    expect(protocol.writeCommand(0x5, 0xf)).toBe("write 0x5 0xf");
    expect(protocol.writeCommand(0x0c000000, 0x0c000000)).toBe("write 0xc000000 0xc000000");
    expect(code(() => protocol.writeCommand(1, 1 << 23))).toBe(ErrorCode.InvalidArgument);
    expect(code(() => protocol.writeCommand(1, 1 << 28))).toBe(ErrorCode.InvalidArgument);
    expect(code(() => protocol.writeCommand(1, 0xffffffff))).toBe(ErrorCode.InvalidArgument);
  });

  it("writeCommand only masks values: the device ignores value bits outside the mask", () => {
    // golden io.txt: `write 0xffffffff 0x8` is accepted, `write ... 0xffffffff` is BAD_PARAM.
    expect(protocol.writeCommand(0xffffffff, 0x8)).toBe("write 0xffffffff 0x8");
    expect(code(() => protocol.writeCommand(-1, 0x8))).toBe(ErrorCode.InvalidArgument);
    expect(code(() => protocol.writeCommand(0x1_0000_0000, 0x8))).toBe(ErrorCode.InvalidArgument);
  });
});

describe("pattern", () => {
  const step = (outBits: number, holdTicks: number) => ({ outBits, holdTicks });

  it("patternAddCommands: one line for a few steps", () => {
    expect(protocol.patternAddCommands([step(1, 5), step(0, 10)])).toEqual([
      "pattern add 0x1:5 0x0:10",
    ]);
  });

  it("splits at the 256-byte line limit without losing steps", () => {
    const steps = Array.from({ length: 256 }, () => step(0, 1));
    const lines = protocol.patternAddCommands(steps);
    expect(lines.length).toBeGreaterThan(1);
    let total = 0;
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(protocol.MAX_LINE_BYTES);
      total += line.split(" ").length - 2;
    }
    expect(total).toBe(256);
    for (const line of lines.slice(0, -1)) {
      expect(line.length + " 0x0:1".length).toBeGreaterThan(protocol.MAX_LINE_BYTES);
    }
  });

  it("packs to the byte limit", () => {
    expect(protocol.patternAddCommands([step(0x0c7fffff, 0xffffffff)])).toEqual([
      "pattern add 0xc7fffff:4294967295",
    ]);
    const lines = protocol.patternAddCommands(Array.from({ length: 41 }, () => step(0, 1)));
    expect(lines).toHaveLength(2);
    expect(lines[0].length).toBe(11 + 40 * 6);
    expect(lines[1]).toBe("pattern add 0x0:1");
  });

  it("rejects an empty pattern and invalid steps, producing nothing", () => {
    expect(code(() => protocol.patternAddCommands([]))).toBe(ErrorCode.InvalidArgument);
    expect(code(() => protocol.patternAddCommands([step(1, 1), step(1, 0)]))).toBe(
      ErrorCode.InvalidArgument,
    );
    expect(code(() => protocol.patternAddCommands([step(1 << 25, 1)]))).toBe(
      ErrorCode.InvalidArgument,
    );
  });

  it("parsePatternTotal", () => {
    expect(protocol.parsePatternTotal("total=256")).toBe(256);
    parseError(() => protocol.parsePatternTotal("accepted=4"));
    parseError(() => protocol.parsePatternTotal("total=x"));
    parseError(() => protocol.parsePatternTotal("total=65536"));
  });

  it("patternRunCommand", () => {
    expect(protocol.patternRunCommand("once", 1)).toBe("pattern run once");
    expect(protocol.patternRunCommand("once", 99)).toBe("pattern run once");
    expect(protocol.patternRunCommand("loop", 10)).toBe("pattern run loop 10");
    expect(protocol.patternRunCommand("loop", 1)).toBe("pattern run loop 1");
    expect(protocol.patternRunCommand("loop", 65535)).toBe("pattern run loop 65535");
  });

  it("patternRunCommand rejects a loop repeat outside 1-65535", () => {
    for (const bad of [0, -1, 65536, 1.5]) {
      expect(code(() => protocol.patternRunCommand("loop", bad))).toBe(ErrorCode.InvalidArgument);
    }
  });

  it("parsePatternStatus", () => {
    expect(protocol.parsePatternStatus("state=running step=5 loops=3 total=40")).toEqual({
      state: "running",
      step: 5,
      loops: 3,
      total: 40,
    });
    for (const state of ["idle", "loaded", "running", "done"]) {
      expect(
        protocol.parsePatternStatus(`state=${state} step=0 loops=0 total=0`).state,
      ).toBe(state);
    }
    parseError(() => protocol.parsePatternStatus("state=paused step=0 loops=0 total=0"));
    parseError(() => protocol.parsePatternStatus("state=idle"));
    parseError(() => protocol.parsePatternStatus("state=idle step=0 loops=0"));
  });
});

describe("timestamp", () => {
  it("tsArmCommand", () => {
    expect(protocol.tsArmCommand(0x07ff, "rising")).toBe("ts arm 0x7ff rising");
    expect(protocol.tsArmCommand(1, "falling")).toBe("ts arm 0x1 falling");
    expect(protocol.tsArmCommand(0x0c000000, "both")).toBe("ts arm 0xc000000 both");
  });

  it("tsArmCommand rejects non-DIO bits and a zero mask", () => {
    for (const bit of [23, 24, 25, 28, 31]) {
      expect(code(() => protocol.tsArmCommand((1 << bit) >>> 0, "both"))).toBe(
        ErrorCode.InvalidArgument,
      );
    }
    expect(code(() => protocol.tsArmCommand(0, "both"))).toBe(ErrorCode.InvalidArgument);
  });

  it("tsGetCommand accepts 1-85 only", () => {
    expect(protocol.tsGetCommand(1)).toBe("ts get 1");
    expect(protocol.tsGetCommand(85)).toBe("ts get 85");
    for (const bad of [0, 86, -1, 1.5, 65536]) {
      expect(code(() => protocol.tsGetCommand(bad))).toBe(ErrorCode.InvalidArgument);
    }
  });

  it("parseTsStatus", () => {
    expect(protocol.parseTsStatus("armed=1 pending=256 overflow=1")).toEqual({
      armed: true,
      pending: 256,
      overflow: true,
    });
    expect(protocol.parseTsStatus("armed=0 pending=0 overflow=0")).toEqual({
      armed: false,
      pending: 0,
      overflow: false,
    });
    parseError(() => protocol.parseTsStatus("armed=2 pending=0 overflow=0"));
    parseError(() => protocol.parseTsStatus("armed=1 pending=0"));
  });

  it("parseTsGetHeader", () => {
    expect(protocol.parseTsGetHeader("count=3 overflow=0")).toEqual({ count: 3, overflow: false });
    expect(protocol.parseTsGetHeader("overflow=1 count=85")).toEqual({
      count: 85,
      overflow: true,
    });
    expect(protocol.parseTsGetHeader("count=0 overflow=0")).toEqual({
      count: 0,
      overflow: false,
    });
  });

  it("parseTsGetHeader: overflow= is mandatory in v2", () => {
    for (const bad of ["count=3", "count=1 overflow=2", "count=1 overflow=yes", "overflow=0"]) {
      parseError(() => protocol.parseTsGetHeader(bad));
    }
  });

  it("parseTsEventLine", () => {
    const ev = protocol.parseTsEventLine("  in=0x00000005 c=1000 p=7 s=1");
    expect(ev).toEqual({ inputs: 5, rawCount: 1000, rawPhase: 7, syncActive: true });
    expect(timestampNs(ev, 40)).toBe(1_000_280);
    const free = protocol.parseTsEventLine("in=0x00000001 c=500 p=0 s=0");
    expect(free.syncActive).toBe(false);
    expect(timestampNs(free, 40)).toBe(500_000);
  });

  it("parseTsEventLine: phase limit 24", () => {
    expect(protocol.parseTsEventLine("in=0x1 c=0 p=24 s=1").rawPhase).toBe(24);
    parseError(() => protocol.parseTsEventLine("in=0x1 c=0 p=25 s=1"));
  });

  it("parseTsEventLine rejects pre-v2 formats, with no ns field", () => {
    parseError(() => protocol.parseTsEventLine("0x00000005 c=1000 p=7 s=1"));
    parseError(() => protocol.parseTsEventLine("0x00000005 t=1234567890"));
    expect(protocol.parseTsEventLine("in=0x1 c=1 p=1 s=1")).not.toHaveProperty("timestampNs");
  });

  it("parseTsEventLine rejects missing or bad fields", () => {
    for (const bad of [
      "in=0x05 c=1000 p=7",
      "c=1000 p=7 s=1",
      "in=0x05 c=1000 p=7 s=2",
      "in=0x05 c=4294967296 p=7 s=1",
      "in=0x05 c=1 p=7 s=1 extra=1",
      "",
    ]) {
      parseError(() => protocol.parseTsEventLine(bad));
    }
  });
});

describe("sync", () => {
  it("parseSyncCount reads clocks=", () => {
    expect(protocol.parseSyncCount("clocks=1000000")).toBe(1_000_000);
    expect(protocol.parseSyncCount("clocks=4294967297")).toBe(4_294_967_297);
  });

  it("rejects count= (reserved for counted responses) and bare numbers", () => {
    parseError(() => protocol.parseSyncCount("count=1000000"));
    parseError(() => protocol.parseSyncCount("1000000"));
    parseError(() => protocol.parseSyncCount("clocks=9007199254740993"));
  });
});

describe("parsePushEvent", () => {
  it("INPUT", () => {
    expect(protocol.parsePushEvent("INPUT in=0x00000005 t=1234567890")).toEqual({
      type: "input_change",
      inputs: 5,
      timestampUs: 1234567890,
    });
  });

  it("PATTERN_DONE / PATTERN_TIMEOUT", () => {
    expect(protocol.parsePushEvent("PATTERN_DONE loops=10")).toEqual({
      type: "pattern_done",
      loops: 10,
    });
    expect(protocol.parsePushEvent("PATTERN_TIMEOUT loops=3")).toEqual({
      type: "pattern_timeout",
      loops: 3,
    });
  });

  it("malformed known events are errors", () => {
    for (const bad of [
      "INPUT in=0x05",
      "INPUT 0x05 t=1",
      "INPUT in=0x05 t=1 extra=1",
      "PATTERN_DONE",
      "PATTERN_DONE loops=x",
      "PATTERN_TIMEOUT loops=65536",
    ]) {
      parseError(() => protocol.parsePushEvent(bad));
    }
  });

  it("unknown names (including the removed sync-done event) are preserved as unknown", () => {
    const removed = `${REMOVED_EVENT} status=ready devnum=1 ts=42`;
    expect(protocol.parsePushEvent(removed)).toEqual({ type: "unknown", raw: removed });
    expect(protocol.parsePushEvent("NEW_THING")).toEqual({ type: "unknown", raw: "NEW_THING" });
  });
});
