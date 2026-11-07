/**
 * Connection safety API: commands, typed errors, `failsafe` event and
 * `applySafety` (docs/sdk-api-design.md "Safety Commands", "Applying a
 * safety.toml"). Mirrors the tests of `sdk/rust/src/connection.rs`.
 *
 * The fake devices answer with lines whose shapes are the golden ones: the
 * strict parsers replay every golden response in golden.test.ts, and
 * "model device answers in the golden key order" below ties the generated
 * `safety` / `excl get` lines to the transcript. Hand-written error lines are
 * negative coverage.
 */
import { describe, expect, it } from "vitest";
import { Connection } from "../src/connection.js";
import { ErrorCode, ExclusiveError, SdkError } from "../src/errors.js";
import type { PushEvent, SafetyConfig } from "../src/types.js";
import { EchoPort, type Handler } from "./helpers/echo-port.js";
import { goldenCase, goldenResponse } from "./helpers/golden.js";

async function connect(handler: Handler): Promise<{ conn: Connection; port: EchoPort }> {
  const port = new EchoPort(handler);
  const conn = await Connection.fromPort(port);
  conn.setTimeout(300);
  return { conn, port };
}

async function codeOf(promise: Promise<unknown>): Promise<ErrorCode> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SdkError);
    return (err as SdkError).code;
  }
  throw new Error("expected an SdkError");
}

describe("safety commands", () => {
  it("send the documented text and parse the answers", async () => {
    const { conn, port } = await connect((cmd) => {
      switch (cmd) {
        case "safety":
          return ["OK wdog_ms=500 remaining_ms=377 failsafe=0 cause=none usbsafe=1 excl=2"];
        case "rstinfo":
          return ["OK cause=por uptime_ms=1500 boot=0x00000001"];
        case "pads":
          return ["OK out=0x00000005 pad=0x00000001"];
        case "excl get":
          return ["OK count=2", "  mask=0x0000000c", "  mask=0x00000018"];
        case "wdog 500":
        case "wdog 0":
        case "failsafe clear":
        case "outputs reset":
        case "excl set 0xc":
        case "excl clear":
        case "usbsafe on":
        case "usbsafe off":
          return ["OK"];
        default:
          return undefined;
      }
    });
    await conn.wdog(500);
    await conn.wdog(0);
    await conn.failsafeClear();
    await conn.outputsReset();
    await conn.exclSet([0xc]);
    await conn.exclClear();
    await conn.usbsafe(true);
    await conn.usbsafe(false);
    const st = await conn.safety();
    expect([st.wdogMs, st.remainingMs, st.excl]).toEqual([500, 377, 2]);
    expect(await conn.exclGet()).toEqual([0xc, 0x18]);
    expect((await conn.rstinfo()).uptimeMs).toBe(1500);
    expect((await conn.pads()).pad).toBe(1);
    expect(port.commands).toEqual([
      "version",
      "wdog 500",
      "wdog 0",
      "failsafe clear",
      "outputs reset",
      "excl set 0xc",
      "excl clear",
      "usbsafe on",
      "usbsafe off",
      "safety",
      "excl get",
      "rstinfo",
      "pads",
    ]);
    await conn.close();
  });

  it("refuse bad arguments without sending", async () => {
    const { conn, port } = await connect(() => undefined);
    expect(await codeOf(conn.wdog(99))).toBe(ErrorCode.InvalidArgument);
    expect(await codeOf(conn.wdog(10_001))).toBe(ErrorCode.InvalidArgument);
    expect(await codeOf(conn.exclSet([]))).toBe(ErrorCode.InvalidArgument);
    expect(await codeOf(conn.exclSet([0x1]))).toBe(ErrorCode.InvalidArgument);
    expect(port.commands).toEqual(["version"]);
    await conn.close();
  });

  it("negative: FAILSAFE and EXCLUSIVE are typed, EXCLUSIVE with its data", async () => {
    const { conn } = await connect((cmd) => {
      switch (cmd) {
        case "write 0x1 0x1":
          return ["ERR FAILSAFE"];
        case "write 0x8 0x8":
          return ["ERR EXCLUSIVE group=1 mask=0x0000000c"];
        case "wdog 100":
          return ["ERR EXCLUSIVE group=0 mask=0x3 future=1"];
        default:
          return undefined;
      }
    });
    expect(await codeOf(conn.write(1, 1))).toBe(ErrorCode.Failsafe);
    const err = await conn.write(8, 8).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ExclusiveError);
    expect([(err as ExclusiveError).group, (err as ExclusiveError).mask]).toEqual([1, 0xc]);
    // Further key=value tokens never make the line unparseable.
    const err2 = (await conn.wdog(100).then(
      () => undefined,
      (e: unknown) => e,
    )) as ExclusiveError;
    expect([err2.group, err2.mask]).toEqual([0, 3]);
    await conn.close();
  });

  it("negative: a short excl get times out as a counted response", async () => {
    const { conn } = await connect((cmd) => (cmd === "excl get" ? ["OK count=2", "  mask=0x3"] : undefined));
    expect(await codeOf(conn.exclGet())).toBe(ErrorCode.Timeout);
    await conn.close();
  });

  it("negative: a plain OK to excl get (no count) is a Parse error", async () => {
    const { conn } = await connect((cmd) => (cmd === "excl get" ? ["OK"] : undefined));
    expect(await codeOf(conn.exclGet())).toBe(ErrorCode.Parse);
    await conn.close();
  });

  it("negative: a safety answer whose latch and cause disagree is Parse", async () => {
    const { conn } = await connect((cmd) =>
      cmd === "safety"
        ? ["OK wdog_ms=0 remaining_ms=0 failsafe=1 cause=none usbsafe=0 excl=0"]
        : undefined,
    );
    expect(await codeOf(conn.safety())).toBe(ErrorCode.Parse);
    await conn.close();
  });
});

describe("failsafe event", () => {
  it("is emitted as a typed event and reaches subscribeEvents", async () => {
    const { conn, port } = await connect((cmd) => (cmd === "subscribe on" ? ["OK"] : undefined));
    const seen: Array<{ cause: string }> = [];
    conn.on("failsafe", (e) => seen.push(e));
    const received: PushEvent[] = [];
    await conn.subscribeEvents((e) => received.push(e));
    port.feed("! FAILSAFE cause=wdog", "! FAILSAFE cause=usb");
    expect(seen).toEqual([{ cause: "wdog" }, { cause: "usb" }]);
    expect(received).toEqual([
      { type: "failsafe", cause: "wdog" },
      { type: "failsafe", cause: "usb" },
    ]);
    await conn.close();
  });

  it("negative: a FAILSAFE event without a cause is discarded and logged", async () => {
    const { conn, port } = await connect(() => undefined);
    const logged: string[] = [];
    conn.logError = (m) => logged.push(m);
    const seen: unknown[] = [];
    conn.on("failsafe", (e) => seen.push(e));
    port.feed("! FAILSAFE cause=none");
    expect(seen).toEqual([]);
    expect(logged).toHaveLength(1);
    await conn.close();
  });
});

/** A device that models the volatile safety state so `applySafety` can read it back. */
class SafetyDevice {
  wdogMs = 0;
  usbsafe = false;
  groups: number[] = [];
  /** The named command answers `ERR BAD_PARAM`. */
  failOn: string | undefined;
  /** Report a wrong `wdog_ms` and a wrong first group in the read-back. */
  lie = false;
  /** Report the opposite `usbsafe` in `safety` only. */
  lieUsbsafe = false;
  /** `excl get` returns this many groups more (positive) or fewer (negative); `safety` stays truthful. */
  exclGetExtra = 0;

  readonly handler: Handler = (cmd) => {
    if (this.failOn !== undefined && cmd.startsWith(this.failOn)) return ["ERR BAD_PARAM"];
    const words = cmd.split(" ");
    if (cmd.startsWith("excl set ")) {
      this.groups = words.slice(2).map(Number);
      return ["OK"];
    }
    if (cmd === "excl clear") {
      this.groups = [];
      return ["OK"];
    }
    if (words[0] === "usbsafe") {
      this.usbsafe = words[1] === "on";
      return ["OK"];
    }
    if (words[0] === "wdog") {
      this.wdogMs = Number(words[1]);
      return ["OK"];
    }
    if (cmd === "safety") {
      const usb = this.usbsafe !== this.lieUsbsafe;
      return [
        `OK wdog_ms=${this.wdogMs + (this.lie ? 1 : 0)} remaining_ms=${this.wdogMs} failsafe=0 cause=none usbsafe=${usb ? 1 : 0} excl=${this.groups.length}`,
      ];
    }
    if (cmd === "excl get") {
      const masks = this.groups.map((m, i) => (this.lie && i === 0 ? m ^ 0x100 : m));
      if (this.exclGetExtra >= 0) {
        for (let i = 0; i < this.exclGetExtra; i++) masks.push(3);
      } else {
        masks.length = Math.max(0, masks.length + this.exclGetExtra);
      }
      return [
        `OK count=${masks.length}`,
        ...masks.map((m) => `  mask=0x${m.toString(16).padStart(8, "0")}`),
      ];
    }
    return undefined;
  };
}

async function safetyConn(
  tweak: (dev: SafetyDevice) => void = () => undefined,
): Promise<{ conn: Connection; port: EchoPort; dev: SafetyDevice }> {
  const dev = new SafetyDevice();
  tweak(dev);
  const { conn, port } = await connect(dev.handler);
  return { conn, port, dev };
}

const FULL: SafetyConfig = { watchdogMs: 800, usbsafe: true, groups: [0xc, 0x18] };

describe("model device answers in the golden key order", () => {
  it("safety and excl get lines have the golden shape", async () => {
    const safetyGolden = goldenResponse(goldenCase("safety", "safety_initial_state"), "safety")[0];
    const keys = (line: string): string[] => line.replace(/^OK /, "").split(" ").map((t) => t.split("=")[0]);
    const ours = new SafetyDevice().handler("safety");
    expect(keys(ours?.[0] ?? "")).toEqual(keys(safetyGolden));
    const excl = goldenCase("safety", "safety_excl_set_get_roundtrip");
    const goldenGet = excl.items.find((i) => i.kind === "request" && i.text === "excl get" && i.response.length > 1);
    const dev = new SafetyDevice();
    dev.groups = [0xc];
    const oursGet = dev.handler("excl get") ?? [];
    if (goldenGet?.kind !== "request") throw new Error("no excl get in the golden case");
    expect(oursGet[1]).toMatch(/^ {2}mask=0x[0-9a-f]{8}$/);
    expect(goldenGet.response[1]).toMatch(/^ {2}mask=0x[0-9a-f]{8}$/);
  });
});

describe("applySafety", () => {
  it("sends the DD-16 order, then reads back safety and excl get", async () => {
    const { conn, port, dev } = await safetyConn();
    const st = await conn.applySafety(FULL);
    expect(port.commands).toEqual([
      "version",
      "excl set 0xc 0x18",
      "usbsafe on",
      "wdog 800",
      "safety",
      "excl get",
    ]);
    expect([st.wdogMs, st.usbsafe, st.excl]).toEqual([800, true, 2]);
    expect(dev.groups).toEqual([0xc, 0x18]);
    await conn.close();
  });

  it("without groups it clears them and never sets", async () => {
    const { conn, port } = await safetyConn((d) => {
      d.groups = [3];
    });
    await conn.applySafety({ watchdogMs: 0, usbsafe: false, groups: [] });
    expect(port.commands).toEqual(["version", "excl clear", "usbsafe off", "wdog 0", "safety", "excl get"]);
    await conn.close();
  });

  it("never sends excl clear before excl set", async () => {
    const { conn, port } = await safetyConn();
    await conn.applySafety(FULL);
    expect(port.commands).not.toContain("excl clear");
    await conn.close();
  });

  it("stops at the first error, keeps its code, sends nothing later and does not read back", async () => {
    for (const [failOn, sent] of [
      ["excl set", ["excl set 0xc 0x18"]],
      ["usbsafe", ["excl set 0xc 0x18", "usbsafe on"]],
      ["wdog", ["excl set 0xc 0x18", "usbsafe on", "wdog 800"]],
    ] as const) {
      const { conn, port } = await safetyConn((d) => {
        d.failOn = failOn;
      });
      expect(await codeOf(conn.applySafety(FULL)), failOn).toBe(ErrorCode.BadParam);
      expect(port.commands, failOn).toEqual(["version", ...sent]);
      await conn.close();
    }
  });

  it("refuses an invalid configuration before sending anything", async () => {
    const { conn, port } = await safetyConn();
    expect(await codeOf(conn.applySafety({ ...FULL, watchdogMs: 50 }))).toBe(ErrorCode.InvalidArgument);
    expect(await codeOf(conn.applySafety({ ...FULL, groups: [1] }))).toBe(ErrorCode.InvalidArgument);
    expect(port.commands).toEqual(["version"]);
    await conn.close();
  });

  it("detects a read-back that differs, naming every difference", async () => {
    const { conn } = await safetyConn((d) => {
      d.lie = true;
    });
    const err = await conn.applySafety(FULL).then(
      () => undefined,
      (e: unknown) => e as SdkError,
    );
    expect(err?.code).toBe(ErrorCode.SafetyMismatch);
    expect(err?.message).toContain("wdog_ms is 801, expected 800");
    expect(err?.message).toContain("group 0 is 0x0000010c, expected 0x0000000c");
    await conn.close();
  });

  it("detects a differing usbsafe alone", async () => {
    const { conn } = await safetyConn((d) => {
      d.lieUsbsafe = true;
    });
    const err = await conn.applySafety(FULL).then(
      () => undefined,
      (e: unknown) => e as SdkError,
    );
    expect(err?.code).toBe(ErrorCode.SafetyMismatch);
    expect(err?.message).toContain("usbsafe is 0, expected 1");
    expect(err?.message).not.toContain(";");
    await conn.close();
  });

  it("detects an excl get with extra or missing groups while safety reports the right count", async () => {
    for (const [extra, want] of [
      [1, "excl get returned 3 groups, expected 2"],
      [-1, "excl get returned 1 groups, expected 2"],
    ] as const) {
      const { conn } = await safetyConn((d) => {
        d.exclGetExtra = extra;
      });
      const err = await conn.applySafety(FULL).then(
        () => undefined,
        (e: unknown) => e as SdkError,
      );
      expect(err?.code, `extra ${extra}`).toBe(ErrorCode.SafetyMismatch);
      expect(err?.message, `extra ${extra}`).toContain(want);
      await conn.close();
    }
  });

  it("returns the safety state that was read, including a latch set before", async () => {
    const { conn } = await connect((cmd) => {
      if (cmd === "safety") {
        return ["OK wdog_ms=0 remaining_ms=0 failsafe=1 cause=wdog usbsafe=0 excl=0"];
      }
      if (cmd === "excl get") return ["OK count=0"];
      return ["OK"];
    });
    const st = await conn.applySafety({ watchdogMs: 0, usbsafe: false, groups: [] });
    expect([st.failsafe, st.cause]).toEqual([true, "wdog"]);
    await conn.close();
  });
});

describe("close", () => {
  it("sends no command and changes no output", async () => {
    const { conn, port } = await safetyConn();
    await conn.applySafety(FULL);
    const before = [...port.commands];
    await conn.close();
    expect(port.commands).toEqual(before);
  });
});
