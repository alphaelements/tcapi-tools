/**
 * Safety functions: typed errors, feature bits, command builders and response
 * parsers (docs/sdk-api-design.md sections 2-4). Mirrors the unit tests of
 * `sdk/rust/src/{error,types,protocol}.rs`. Parsers are checked against the
 * golden transcripts in golden.test.ts; hand-written lines here are negative
 * (malformed-input) coverage or boundary values.
 */
import { describe, expect, it } from "vitest";
import { ErrorCode, ExclusiveError, SdkError } from "../src/errors.js";
import * as protocol from "../src/protocol.js";
import {
  FEAT_EXCL,
  FEAT_OUTRESET,
  FEAT_PADS,
  FEAT_RESET,
  FEAT_RSTINFO,
  FEAT_SYNC,
  FEAT_USBSAFE,
  FEAT_WDOG,
  FEATURE_ALL,
  FEATURE_MASK,
  Feature,
  MAX_EXCLUSIVE_GROUPS,
  WDOG_MAX_MS,
  WDOG_MIN_MS,
  defaultSafetyConfig,
  failsafeCauseFromName,
  featureBit,
  featureList,
  hasFeature,
  hasReset,
  hasSync,
  resetCauseFromName,
  type Capabilities,
  type SafetyConfig,
} from "../src/types.js";

function caps(features: number): Capabilities {
  return { dio: 25, out: 4, in: 21, tsResNs: 40, tickNs: 200, patternMax: 256, ring: 256, features };
}

function codeOf(fn: () => unknown): ErrorCode {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SdkError);
    return (err as SdkError).code;
  }
  throw new Error("expected an SdkError");
}

describe("ERR mapping: FAILSAFE and EXCLUSIVE", () => {
  it("FAILSAFE and TRANSPORT_NOT_SUPPORTED are typed", () => {
    expect(SdkError.fromErrorCode("FAILSAFE").code).toBe(ErrorCode.Failsafe);
    expect(SdkError.fromErrorCode("TRANSPORT_NOT_SUPPORTED").code).toBe(
      ErrorCode.TransportNotSupported,
    );
    expect(ErrorCode.Failsafe).toBe("FAILSAFE");
    expect(ErrorCode.Exclusive).toBe("EXCLUSIVE");
    expect(ErrorCode.SafetyMismatch).toBe("SAFETY_MISMATCH");
  });

  it("EXCLUSIVE carries group and mask", () => {
    const err = SdkError.fromErrorCode("EXCLUSIVE group=1 mask=0x0000000c");
    expect(err).toBeInstanceOf(ExclusiveError);
    expect(err.code).toBe(ErrorCode.Exclusive);
    const ex = err as ExclusiveError;
    expect([ex.group, ex.mask]).toEqual([1, 0xc]);
    expect(ex.message).toBe(
      "device error: EXCLUSIVE (exclusive group 1 would be violated, mask 0x0000000c)",
    );
  });

  it("token order is free and further key=value tokens are tolerated", () => {
    const ex = SdkError.fromErrorCode("EXCLUSIVE mask=0x7 extra=zz group=15 more=1") as ExclusiveError;
    expect([ex.group, ex.mask]).toEqual([15, 7]);
  });

  it("mask may be decimal; the full u32 range is accepted", () => {
    const ex = SdkError.fromErrorCode("EXCLUSIVE group=255 mask=4294967295") as ExclusiveError;
    expect([ex.group, ex.mask]).toEqual([255, 0xffffffff]);
  });

  it("negative: EXCLUSIVE without valid data is Parse, never a default", () => {
    for (const bad of [
      "EXCLUSIVE",
      "EXCLUSIVE group=0",
      "EXCLUSIVE mask=0x3",
      "EXCLUSIVE group=x mask=0x3",
      "EXCLUSIVE group=256 mask=0x3",
      "EXCLUSIVE group=-1 mask=0x3",
      "EXCLUSIVE group=+1 mask=0x3",
      "EXCLUSIVE group=0 mask=zz",
      "EXCLUSIVE group=0 mask=0x",
      "EXCLUSIVE group=0 mask=0x100000000",
      "EXCLUSIVE group=0 mask=4294967296",
    ]) {
      expect(codeOf(() => { throw SdkError.fromErrorCode(bad); }), bad).toBe(ErrorCode.Parse);
    }
  });

  it("data tokens after a plain name are ignored", () => {
    expect(SdkError.fromErrorCode("BUSY detail=1").code).toBe(ErrorCode.Busy);
    expect(SdkError.fromErrorCode("FAILSAFE cause=wdog").code).toBe(ErrorCode.Failsafe);
  });

  it("an unknown name keeps the whole text", () => {
    const err = SdkError.fromErrorCode("NEW_ERR a=1");
    expect(err.code).toBe(ErrorCode.UnknownDevice);
    expect(err.message).toBe("device error: NEW_ERR a=1");
  });

  it("okData maps a response carrying data tokens", () => {
    const resp = protocol.parseResponse("ERR EXCLUSIVE group=0 mask=0x0000000c");
    expect(() => protocol.okData(resp)).toThrow(ExclusiveError);
  });

  it("an empty ERR text is an unknown device error, not a crash", () => {
    expect(SdkError.fromErrorCode("").code).toBe(ErrorCode.UnknownDevice);
  });
});

describe("feature bits", () => {
  it("are the protocol bits, in bit order", () => {
    expect(FEATURE_ALL.map((f) => [f, featureBit(f)])).toEqual([
      [Feature.Sync, 0x01],
      [Feature.Reset, 0x02],
      [Feature.Wdog, 0x04],
      [Feature.Excl, 0x08],
      [Feature.OutReset, 0x10],
      [Feature.RstInfo, 0x20],
      [Feature.UsbSafe, 0x40],
      [Feature.Pads, 0x80],
    ]);
    expect(FEATURE_MASK).toBe(0xff);
    expect([FEAT_SYNC, FEAT_RESET, FEAT_WDOG, FEAT_EXCL]).toEqual([1, 2, 4, 8]);
    expect([FEAT_OUTRESET, FEAT_RSTINFO, FEAT_USBSAFE, FEAT_PADS]).toEqual([0x10, 0x20, 0x40, 0x80]);
  });

  it("hasFeature tests each bit and featureList keeps bit order", () => {
    const c = caps(FEAT_WDOG | FEAT_PADS);
    expect(hasFeature(c, Feature.Wdog) && hasFeature(c, Feature.Pads)).toBe(true);
    for (const f of [Feature.Sync, Feature.Reset, Feature.Excl, Feature.OutReset, Feature.RstInfo, Feature.UsbSafe]) {
      expect(hasFeature(c, f), f).toBe(false);
    }
    expect(featureList(c)).toEqual([Feature.Wdog, Feature.Pads]);
    expect(featureList(caps(0xff))).toEqual([...FEATURE_ALL]);
    expect(featureList(caps(0))).toEqual([]);
  });

  it("hasSync / hasReset agree with hasFeature", () => {
    expect(hasSync(caps(FEAT_SYNC))).toBe(true);
    expect(hasSync(caps(FEAT_RESET))).toBe(false);
    expect(hasReset(caps(FEAT_RESET))).toBe(true);
  });

  it("an undefined high bit is not listed", () => {
    expect(featureList(caps(0x100 | FEAT_EXCL))).toEqual([Feature.Excl]);
  });
});

describe("cause names", () => {
  it("failsafe causes round-trip and are case-sensitive", () => {
    for (const name of ["none", "wdog", "usb"] as const) {
      expect(failsafeCauseFromName(name)).toBe(name);
    }
    expect(failsafeCauseFromName("WDOG")).toBeUndefined();
    expect(failsafeCauseFromName("")).toBeUndefined();
  });

  it("reset causes round-trip and are case-sensitive", () => {
    for (const name of ["por", "wdt", "soft", "bor", "other"] as const) {
      expect(resetCauseFromName(name)).toBe(name);
    }
    expect(resetCauseFromName("reset")).toBeUndefined();
    expect(resetCauseFromName("constructor")).toBeUndefined();
  });
});

describe("wdog / usbsafe / excl set commands", () => {
  it("wdog accepts 0 and the documented range", () => {
    expect(protocol.wdogCommand(0)).toBe("wdog 0");
    expect(protocol.wdogCommand(WDOG_MIN_MS)).toBe("wdog 100");
    expect(protocol.wdogCommand(WDOG_MAX_MS)).toBe("wdog 10000");
    for (const bad of [1, 99, 10_001, 4_294_967_295, -1, 100.5, Number.NaN]) {
      expect(codeOf(() => protocol.wdogCommand(bad)), String(bad)).toBe(ErrorCode.InvalidArgument);
    }
  });

  it("usbsafe is on or off", () => {
    expect(protocol.usbsafeCommand(true)).toBe("usbsafe on");
    expect(protocol.usbsafeCommand(false)).toBe("usbsafe off");
  });

  it("excl set checks the groups before anything is sent", () => {
    expect(protocol.exclSetCommand([0xc])).toBe("excl set 0xc");
    expect(protocol.exclSetCommand([0xc, 0x18])).toBe("excl set 0xc 0x18");
    expect(protocol.exclSetCommand(Array<number>(MAX_EXCLUSIVE_GROUPS).fill(3)).match(/0x3/g)).toHaveLength(16);
    expect(codeOf(() => protocol.exclSetCommand([]))).toBe(ErrorCode.InvalidArgument);
    expect(codeOf(() => protocol.exclSetCommand(Array<number>(17).fill(3)))).toBe(ErrorCode.InvalidArgument);
    // fewer than two pins, and pins outside VALID_DIO_MASK
    for (const bad of [0, 0x1, 0x80000000, 0x00800003, 0x10000003, -3, 3.5]) {
      expect(codeOf(() => protocol.exclSetCommand([bad])), String(bad)).toBe(ErrorCode.InvalidArgument);
    }
  });

  it("the faulty group is named", () => {
    expect(() => protocol.exclSetCommand([0x3, 0x1])).toThrow(/group 1/);
  });
});

describe("safety response", () => {
  it("parses every state shape", () => {
    expect(
      protocol.parseSafety("wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0"),
    ).toEqual({ wdogMs: 0, remainingMs: 0, failsafe: false, cause: "none", usbsafe: false, excl: 0 });
    const armed = protocol.parseSafety("wdog_ms=500 remaining_ms=377 failsafe=0 cause=none usbsafe=1 excl=16");
    expect([armed.wdogMs, armed.remainingMs, armed.usbsafe, armed.excl]).toEqual([500, 377, true, 16]);
    const tripped = protocol.parseSafety("wdog_ms=100 remaining_ms=0 failsafe=1 cause=wdog usbsafe=0 excl=0");
    expect([tripped.failsafe, tripped.cause]).toEqual([true, "wdog"]);
    expect(protocol.parseSafety("wdog_ms=0 remaining_ms=0 failsafe=1 cause=usb usbsafe=1 excl=0").cause).toBe("usb");
  });

  it("negative: malformed responses are Parse", () => {
    for (const bad of [
      "",
      "wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0",
      "wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0 extra=1",
      "wdog_ms=x remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0",
      "wdog_ms=0 remaining_ms=0 failsafe=2 cause=none usbsafe=0 excl=0",
      "wdog_ms=0 remaining_ms=0 failsafe=0 cause=other usbsafe=0 excl=0",
      "wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=17",
      "wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=256",
      "wdog_ms=4294967296 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0",
      // The latch and its cause must agree.
      "wdog_ms=0 remaining_ms=0 failsafe=1 cause=none usbsafe=0 excl=0",
      "wdog_ms=0 remaining_ms=0 failsafe=0 cause=wdog usbsafe=0 excl=0",
    ]) {
      expect(codeOf(() => protocol.parseSafety(bad)), bad).toBe(ErrorCode.Parse);
    }
  });
});

describe("rstinfo response", () => {
  it("parses every cause", () => {
    for (const cause of ["por", "wdt", "soft", "bor", "other"] as const) {
      expect(protocol.parseRstinfo(`cause=${cause} uptime_ms=5000 boot=0x00000002`)).toEqual({
        cause,
        uptimeMs: 5000,
        boot: 2,
      });
    }
  });

  it("uptime keeps every exactly representable value", () => {
    expect(protocol.parseRstinfo("cause=por uptime_ms=9007199254740991 boot=0x1").uptimeMs).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("negative: malformed responses are Parse (an uptime beyond 2^53 loses precision and is refused)", () => {
    for (const bad of [
      "cause=reset uptime_ms=0 boot=0x1",
      "cause=por uptime_ms=-1 boot=0x1",
      "cause=por uptime_ms=18446744073709551616 boot=0x1",
      "cause=por uptime_ms=18446744073709551615 boot=0x1",
      "cause=por uptime_ms=0",
      "cause=por uptime_ms=0 boot=zz",
      "cause=por uptime_ms=0 boot=0x100000000",
      "cause=por uptime_ms=0 boot=0x1 more=1",
    ]) {
      expect(codeOf(() => protocol.parseRstinfo(bad)), bad).toBe(ErrorCode.Parse);
    }
  });
});

describe("pads response", () => {
  it("parses in any key order", () => {
    expect(protocol.parsePads("out=0x00000005 pad=0x00000001")).toEqual({ out: 5, pad: 1 });
    expect(protocol.parsePads("pad=0x2 out=0x4")).toEqual({ out: 4, pad: 2 });
  });

  it("negative: malformed responses are Parse", () => {
    for (const bad of ["out=0x5", "out=0x5 pad=zz", "pad=0x1 out=0x5 x=1", ""]) {
      expect(codeOf(() => protocol.parsePads(bad)), bad).toBe(ErrorCode.Parse);
    }
  });
});

describe("excl get response", () => {
  it("reads the counted masks in order", () => {
    expect(protocol.parseExclGet("count=2", ["  mask=0x0000000c", "  mask=0x00000018"])).toEqual([0xc, 0x18]);
    expect(protocol.parseExclGet("count=0", [])).toEqual([]);
  });

  it("negative: inconsistent responses are Parse", () => {
    const one = ["  mask=0x3"];
    for (const [header, lines] of [
      ["count=2", one],
      ["count=0", one],
      ["count=17", []],
      ["count=x", []],
      ["count=1", ["  mask=zz"]],
      ["count=1", ["  bits=0x3"]],
      ["count=1 overflow=0", one],
    ] as const) {
      expect(codeOf(() => protocol.parseExclGet(header, lines)), header).toBe(ErrorCode.Parse);
    }
  });
});

describe("FAILSAFE push event", () => {
  it("parses wdog and usb", () => {
    expect(protocol.parsePushEvent("FAILSAFE cause=wdog")).toEqual({ type: "failsafe", cause: "wdog" });
    expect(protocol.parsePushEvent("FAILSAFE cause=usb")).toEqual({ type: "failsafe", cause: "usb" });
  });

  it("negative: a trip always has a cause, and nothing else is accepted", () => {
    for (const bad of ["FAILSAFE", "FAILSAFE cause=none", "FAILSAFE cause=disk", "FAILSAFE cause=wdog x=1"]) {
      expect(codeOf(() => protocol.parsePushEvent(bad)), bad).toBe(ErrorCode.Parse);
    }
  });
});

describe("SafetyConfig commands (DD-16)", () => {
  const full: SafetyConfig = { watchdogMs: 800, usbsafe: true, groups: [0xc, 0x18] };

  it("follow the DD-16 order", () => {
    expect(protocol.safetyConfigCommands(full)).toEqual(["excl set 0xc 0x18", "usbsafe on", "wdog 800"]);
  });

  it("without groups, excl clear goes first", () => {
    expect(protocol.safetyConfigCommands(defaultSafetyConfig())).toEqual(["excl clear", "usbsafe off", "wdog 0"]);
  });

  it("never send excl clear before excl set", () => {
    const cmds = protocol.safetyConfigCommands({ ...defaultSafetyConfig(), groups: [3] });
    expect(cmds).not.toContain("excl clear");
    expect(cmds[0]).toBe("excl set 0x3");
  });

  it("refuse what the device would refuse, producing nothing", () => {
    for (const bad of [
      { ...defaultSafetyConfig(), watchdogMs: 99 },
      { ...defaultSafetyConfig(), watchdogMs: 10_001 },
      { ...defaultSafetyConfig(), groups: [1] },
      { ...defaultSafetyConfig(), groups: Array<number>(17).fill(3) },
    ]) {
      expect(codeOf(() => protocol.safetyConfigCommands(bad)), JSON.stringify(bad)).toBe(ErrorCode.InvalidArgument);
    }
  });

  it("the default configuration is all off", () => {
    expect(defaultSafetyConfig()).toEqual({ watchdogMs: 0, usbsafe: false, groups: [] });
  });
});

describe("public API and JSON", () => {
  it("the safety API is exported from the package entry point", async () => {
    const api = await import("../src/index.js");
    for (const name of [
      "ConfigError",
      "ExclusiveError",
      "Feature",
      "FEATURE_ALL",
      "FEATURE_MASK",
      "FEAT_WDOG",
      "FEAT_EXCL",
      "FEAT_OUTRESET",
      "FEAT_RSTINFO",
      "FEAT_USBSAFE",
      "FEAT_PADS",
      "Heartbeat",
      "WDOG_MIN_MS",
      "WDOG_MAX_MS",
      "MAX_EXCLUSIVE_GROUPS",
      "defaultSafetyConfig",
      "failsafeCauseFromName",
      "featureBit",
      "featureList",
      "hasFeature",
      "heartbeatPeriodMs",
      "loadSafety",
      "parseSafety",
      "resetCauseFromName",
    ] as const) {
      expect(api[name], name).toBeDefined();
    }
    expect(api.Connection.prototype.applySafety).toBeTypeOf("function");
    expect(api.Connection.prototype.startHeartbeat).toBeTypeOf("function");
  });

  it("types serialise to the snake_case wire JSON of the Rust SDK", async () => {
    const { toWire } = await import("../src/json.js");
    expect(
      toWire({ wdogMs: 500, remainingMs: 1, failsafe: false, cause: "none", usbsafe: true, excl: 2 }),
    ).toEqual({ wdog_ms: 500, remaining_ms: 1, failsafe: false, cause: "none", usbsafe: true, excl: 2 });
    expect(toWire({ cause: "por", uptimeMs: 5, boot: 2 })).toEqual({ cause: "por", uptime_ms: 5, boot: 2 });
    expect(toWire({ watchdogMs: 800, usbsafe: true, groups: [12] })).toEqual({
      watchdog_ms: 800,
      usbsafe: true,
      groups: [12],
    });
    expect(Feature.OutReset).toBe("out_reset");
    expect(Feature.RstInfo).toBe("rst_info");
    expect(Feature.UsbSafe).toBe("usb_safe");
  });
});
