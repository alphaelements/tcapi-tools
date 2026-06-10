import { describe, expect, it } from "vitest";
import { ErrorCode, SdkError } from "../src/errors.js";
import {
  mapToHex,
  okData,
  parseAccepted,
  parseCaps,
  parseCountField,
  parseInfo,
  parseMap,
  parsePatternStatus,
  parsePushEvent,
  parseRead,
  parseResponse,
  parseState,
  parseSyncCount,
  parseTsEventLine,
  parseVersion,
  patternRunCommand,
  patternToHex,
  tsArmCommand,
} from "../src/protocol.js";

function errCode(fn: () => unknown): ErrorCode {
  try {
    fn();
  } catch (err) {
    if (err instanceof SdkError) return err.code;
    throw err;
  }
  throw new Error("expected SdkError");
}

describe("parseResponse", () => {
  it("parses bare OK", () => {
    expect(parseResponse("OK\r\n")).toEqual({ kind: "ok", data: "" });
  });
  it("parses OK with data", () => {
    expect(parseResponse("OK v0.1.0 proto=1\r\n")).toEqual({
      kind: "ok",
      data: "v0.1.0 proto=1",
    });
  });
  it("parses ERR", () => {
    expect(parseResponse("ERR BAD_CMD")).toEqual({ kind: "err", code: "BAD_CMD" });
  });
  it("parses push", () => {
    expect(parseResponse("! INPUT 0x05 t=99")).toEqual({
      kind: "push",
      payload: "INPUT 0x05 t=99",
    });
  });
  it("rejects garbage", () => {
    expect(errCode(() => parseResponse("garbage"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parseResponse("OKAY nope"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parseResponse(""))).toBe(ErrorCode.Parse);
  });
});

describe("okData", () => {
  it("maps device error codes", () => {
    expect(errCode(() => okData({ kind: "err", code: "BUSY" }))).toBe(ErrorCode.Busy);
    expect(errCode(() => okData({ kind: "err", code: "WHAT" }))).toBe(
      ErrorCode.UnknownDevice,
    );
  });
  it("rejects push in response position", () => {
    expect(errCode(() => okData({ kind: "push", payload: "INPUT" }))).toBe(
      ErrorCode.Parse,
    );
  });
});

describe("parseCountField", () => {
  it("parses counts", () => {
    expect(parseCountField("count=2")).toBe(2);
    expect(parseCountField("count=0")).toBe(0);
    expect(parseCountField("count=1000000")).toBe(1000000);
  });
  it("rejects missing or invalid", () => {
    expect(errCode(() => parseCountField("n=2"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parseCountField("count=abc"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parseCountField("count=-1"))).toBe(ErrorCode.Parse);
  });
});

describe("parseVersion", () => {
  it("parses v0.1.0 proto=1", () => {
    expect(parseVersion("v0.1.0 proto=1")).toEqual({
      major: 0,
      minor: 1,
      patch: 0,
      protocolVersion: 1,
    });
  });
  it("parses multi-digit", () => {
    const v = parseVersion("v12.34.56 proto=2");
    expect([v.major, v.minor, v.patch]).toEqual([12, 34, 56]);
  });
  it("rejects malformed", () => {
    for (const bad of ["proto=1", "v0.1.0", "v0.1 proto=1", "vX.Y.Z proto=1", ""]) {
      expect(errCode(() => parseVersion(bad))).toBe(ErrorCode.Parse);
    }
  });
});

describe("parseCaps", () => {
  const good = "dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000001";
  it("parses all fields", () => {
    const c = parseCaps(good);
    expect(c.maxDio).toBe(23);
    expect(c.outCount).toBe(12);
    expect(c.inCount).toBe(11);
    expect(c.tsResolutionNs).toBe(40);
    expect(c.maxPatternSteps).toBe(256);
    expect(c.tsRingEvents).toBe(256);
    expect(c.features).toBe(1);
  });
  it("rejects old firmware ts_res=1000 loudly", () => {
    expect(
      errCode(() =>
        parseCaps("dio=23 out=12 in=11 ts_res=1000ns pattern=256 ring=256 feat=0x1"),
      ),
    ).toBe(ErrorCode.UnsupportedFirmware);
  });
  it("rejects missing fields and bad values", () => {
    expect(errCode(() => parseCaps("dio=23 out=12 in=11"))).toBe(ErrorCode.Parse);
    expect(
      errCode(() =>
        parseCaps("dio=banana out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x1"),
      ),
    ).toBe(ErrorCode.Parse);
  });
});

describe("parseInfo", () => {
  it("parses uid and devnum", () => {
    expect(parseInfo("uid=AABBCCDD11223344 devnum=42")).toEqual({
      uid: "AABBCCDD11223344",
      deviceNumber: 42,
    });
  });
  it("maps devnum 255 to null", () => {
    expect(parseInfo("uid=AABB devnum=255").deviceNumber).toBeNull();
  });
  it("rejects missing uid / bad devnum", () => {
    expect(errCode(() => parseInfo("devnum=1"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parseInfo("uid=AABB devnum=zzz"))).toBe(ErrorCode.Parse);
  });
});

describe("parseMap / mapToHex", () => {
  it("parses a full map", () => {
    expect(parseMap("v=1 out=0:12 in=12:11 pull=up flags=0x01")).toEqual({
      version: 1,
      outBase: 0,
      outCount: 12,
      inBase: 12,
      inCount: 11,
      pull: "up",
      flags: 1,
    });
  });
  it("rejects bad pull / missing field / bad range", () => {
    expect(
      errCode(() => parseMap("v=1 out=0:0 in=0:23 pull=sideways flags=0x01")),
    ).toBe(ErrorCode.Parse);
    expect(errCode(() => parseMap("v=1 out=0:12"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parseMap("v=1 out=012 in=0:23 pull=up flags=0x01"))).toBe(
      ErrorCode.Parse,
    );
  });
  it("round-trips through hex (extended bytes zero)", () => {
    const hex = mapToHex({
      version: 1,
      outBase: 0,
      outCount: 12,
      inBase: 12,
      inCount: 11,
      pull: "up",
      flags: 1,
    });
    expect(hex).toHaveLength(48);
    const bytes = Buffer.from(hex, "hex");
    expect([...bytes.subarray(0, 7)]).toEqual([1, 0, 12, 12, 11, 1, 1]);
    expect([...bytes.subarray(7)].every((b) => b === 0)).toBe(true);
  });
});

describe("read / state", () => {
  it("parses read", () => {
    expect(parseRead("0x000005")).toBe(5);
    expect(parseRead(" 0x0 ")).toBe(0);
  });
  it("rejects bad read", () => {
    expect(errCode(() => parseRead("five"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parseRead(""))).toBe(ErrorCode.Parse);
  });
  it("parses state", () => {
    expect(parseState("in=0x000005 out=0x00000A flags=0x00")).toEqual({
      inputs: 5,
      outputs: 10,
      flags: 0,
    });
  });
  it("rejects state with missing field", () => {
    expect(errCode(() => parseState("in=0x05 out=0x0A"))).toBe(ErrorCode.Parse);
  });
});

describe("pattern", () => {
  it("hex has u16 LE count prefix", () => {
    const hex = patternToHex([
      { outBits: 0x0f, holdUs: 100 },
      { outBits: 0, holdUs: 200 },
    ]);
    const bytes = Buffer.from(hex, "hex");
    expect(bytes).toHaveLength(2 + 2 * 8);
    expect(bytes.readUInt16LE(0)).toBe(2);
    expect(bytes.readUInt32LE(2)).toBe(0x0f);
    expect(bytes.readUInt32LE(6)).toBe(100);
  });
  it("rejects empty pattern", () => {
    expect(errCode(() => patternToHex([]))).toBe(ErrorCode.Parse);
  });
  it("parses accepted", () => {
    expect(parseAccepted("accepted=4")).toBe(4);
    expect(errCode(() => parseAccepted("ok"))).toBe(ErrorCode.Parse);
  });
  it("builds run commands", () => {
    expect(patternRunCommand("once", 1)).toBe("pattern run once 1");
    expect(patternRunCommand("loop", 10)).toBe("pattern run loop 10");
  });
  it("parses status incl. loaded state", () => {
    expect(parsePatternStatus("state=running step=5 loops=3")).toEqual({
      state: "running",
      currentStep: 5,
      loopsDone: 3,
    });
    expect(parsePatternStatus("state=loaded step=0 loops=0").state).toBe("loaded");
    expect(parsePatternStatus("state=idle step=0 loops=0").state).toBe("idle");
    expect(parsePatternStatus("state=done step=9 loops=1").state).toBe("done");
  });
  it("rejects unknown state / missing field", () => {
    expect(errCode(() => parsePatternStatus("state=paused step=0 loops=0"))).toBe(
      ErrorCode.Parse,
    );
    expect(errCode(() => parsePatternStatus("state=idle"))).toBe(ErrorCode.Parse);
  });
});

describe("timestamp", () => {
  it("builds ts arm commands", () => {
    expect(tsArmCommand(0x07ff, "rising")).toBe("ts arm 0x7ff rising");
    expect(tsArmCommand(0xff, "both")).toBe("ts arm 0xff both");
  });
  it("parses an event line with ns computation", () => {
    const ev = parseTsEventLine("  0x00000005 c=1000 p=7 s=1");
    expect(ev).toEqual({
      inputs: 5,
      rawCount: 1000,
      rawPhase: 7,
      syncActive: true,
      timestampNs: 1_000_280,
    });
  });
  it("parses free-running events", () => {
    const ev = parseTsEventLine("0x00000001 c=500 p=0 s=0");
    expect(ev.syncActive).toBe(false);
    expect(ev.timestampNs).toBe(500_000);
  });
  it("rejects old t= format as UnsupportedFirmware", () => {
    expect(errCode(() => parseTsEventLine("0x00000005 t=1234567890"))).toBe(
      ErrorCode.UnsupportedFirmware,
    );
  });
  it("rejects missing fields / bad sync flag", () => {
    expect(errCode(() => parseTsEventLine("0x05 c=1000 p=7"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parseTsEventLine("c=1000 p=7 s=1"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parseTsEventLine("0x05 c=1000 p=7 s=2"))).toBe(ErrorCode.Parse);
  });
});

describe("sync", () => {
  it("parses sync count", () => {
    expect(parseSyncCount("count=1000000")).toBe(1_000_000);
    expect(errCode(() => parseSyncCount("1000000"))).toBe(ErrorCode.Parse);
  });
});

describe("push events", () => {
  it("parses INPUT", () => {
    expect(parsePushEvent("INPUT 0x000005 t=1234567890")).toEqual({
      type: "input_change",
      inputs: 5,
      timestampUs: 1234567890,
    });
  });
  it("parses PATTERN_DONE", () => {
    expect(parsePushEvent("PATTERN_DONE loops=10")).toEqual({
      type: "pattern_done",
      loops: 10,
    });
  });
  it("parses SYNC_DONE", () => {
    expect(parsePushEvent("SYNC_DONE status=ready devnum=1 ts=12345")).toEqual({
      type: "sync_done",
      status: "ready",
      devnum: 1,
      timestamp: 12345,
    });
  });
  it("preserves unknown events", () => {
    expect(parsePushEvent("FUTURE_EVENT data=1")).toEqual({
      type: "unknown",
      raw: "FUTURE_EVENT data=1",
    });
  });
  it("rejects malformed known events", () => {
    expect(errCode(() => parsePushEvent("INPUT t=99"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parsePushEvent("INPUT 0x05"))).toBe(ErrorCode.Parse);
    expect(errCode(() => parsePushEvent("PATTERN_DONE loops=abc"))).toBe(
      ErrorCode.Parse,
    );
  });
});
