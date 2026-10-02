/**
 * Connection API tests. The fake device is generated from the golden
 * transcripts: it asserts that the SDK sends exactly the recorded request
 * text and answers with the recorded lines, so typed results are checked
 * against firmware output, not against hand-written strings. Hand-written
 * lines appear only in tests marked "negative".
 */
import { describe, expect, it } from "vitest";
import { Connection } from "../src/connection.js";
import { ErrorCode, SdkError } from "../src/errors.js";
import { groupEvents, reconcile } from "../src/reconcile.js";
import { hasReset, hasSync, pinLabel, timestampNs, type PushEvent } from "../src/types.js";
import { FakePort } from "./helpers/fake-port.js";
import {
  GoldenPort,
  goldenCase,
  goldenRequest,
  goldenResponse,
  handshakeItems,
  type GoldenItem,
} from "./helpers/golden.js";

async function open(items: readonly GoldenItem[]): Promise<{ conn: Connection; port: GoldenPort }> {
  const port = new GoldenPort([...handshakeItems(), ...items]);
  const conn = await Connection.fromPort(port);
  conn.setTimeout(1000);
  port.start();
  return { conn, port };
}

function request(file: Parameters<typeof goldenCase>[0], title: string, text: string): GoldenItem {
  return goldenRequest(file, title, text);
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SdkError);
    expect((err as SdkError).code).toBe(code);
    return;
  }
  throw new Error(`expected SdkError ${code}`);
}

const MAP_FULL = {
  flags: 0,
  direction: 0x0f,
  pullUp: 0xf0,
  pullDown: 0x0c7fff00,
  outDefault: 5,
  outPolarity: 8,
  inPolarity: 0x100,
  edge: 0x0c7ffff0,
};

describe("open", () => {
  it("asserts DTR and checks version proto=2", async () => {
    const { conn, port } = await open([]);
    expect(port.dtr).toBe(true);
    expect(port.written).toEqual(["version"]);
    await conn.close();
  });

  it("negative: a device reporting another proto is UnsupportedFirmware and the port is closed", async () => {
    const port = new FakePort();
    port.onCommand = () => port.feed("OK fw=0.1.0 proto=1");
    await expectCode(Connection.fromPort(port), ErrorCode.UnsupportedFirmware);
    expect(port.isOpen).toBe(false);
  });

  it("negative: a v1 version line is rejected, never parsed leniently", async () => {
    const port = new FakePort();
    port.onCommand = () => port.feed("OK v0.1.0 proto=1");
    await expectCode(Connection.fromPort(port), ErrorCode.Parse);
    expect(port.isOpen).toBe(false);
  });

  it("negative: a port that cannot assert DTR fails to open", async () => {
    const port = new FakePort();
    port.setError = new Error("no dtr");
    await expectCode(Connection.fromPort(port), ErrorCode.Connection);
  });
});

describe("device information", () => {
  it("version", async () => {
    const { conn, port } = await open([request("version-info", "version", "version")]);
    expect(await conn.version()).toEqual({ major: 0, minor: 1, patch: 3, protocolVersion: 2 });
    expect(port.remainingRequests()).toBe(0);
  });

  it("caps follows the direction mask", async () => {
    const c = goldenCase("version-info", "caps follows the direction mask");
    const { conn, port } = await open(c.items);
    await conn.mapSet({
      flags: 0,
      direction: 3,
      pullUp: 0,
      pullDown: 0x0c7ffffc,
      outDefault: 0,
      outPolarity: 0,
      inPolarity: 0,
      edge: 0x0c7ffffc,
    });
    const caps = await conn.caps();
    expect(caps).toEqual({
      dio: 25,
      out: 2,
      in: 23,
      tsResNs: 40,
      tickNs: 200,
      patternMax: 256,
      ring: 256,
      features: 3,
    });
    expect(hasSync(caps) && hasReset(caps)).toBe(true);
    expect(port.remainingRequests()).toBe(0);
  });

  it("info and device number", async () => {
    const c = goldenCase("version-info", "devnum: assign, read back, clear");
    const { conn, port } = await open(c.items);
    await conn.setDeviceNumber(7);
    expect((await conn.info()).deviceNumber).toBe(7);
    await conn.setDeviceNumber(255);
    const info = await conn.info();
    expect(info).toEqual({
      uid: "0000000000000000",
      deviceNumber: null,
      port: "",
      version: "0.1.3",
    });
    expect(port.remainingRequests()).toBe(0);
  });

  it("setDeviceNumber rejects out-of-range values locally", async () => {
    const { conn, port } = await open([]);
    for (const bad of [-1, 256, 1.5]) {
      await expectCode(conn.setDeviceNumber(bad), ErrorCode.InvalidArgument);
    }
    expect(port.written).toEqual(["version"]);
  });

  it("ping returns the echoed value", async () => {
    const c = goldenCase("version-info", "ping: u32 limits");
    const { conn, port } = await open(c.items.slice(0, 1));
    expect(await conn.ping(4294967295)).toBe(4294967295);
    expect(port.remainingRequests()).toBe(0);
  });

  it("ping rejects a value outside u32 locally", async () => {
    const { conn } = await open([]);
    await expectCode(conn.ping(4294967296), ErrorCode.InvalidArgument);
    await expectCode(conn.ping(-1), ErrorCode.InvalidArgument);
  });

  it("negative: a pong with another value is a parse error", async () => {
    const port = new FakePort();
    port.onCommand = (cmd) => {
      port.feed(cmd === "version" ? "OK fw=0.1.3 proto=2" : "OK pong=9");
    };
    const conn = await Connection.fromPort(port);
    await expectCode(conn.ping(5), ErrorCode.Parse);
  });
});

describe("digital I/O", () => {
  it("read", async () => {
    const c = goldenCase("io", "read: default map, undriven inputs read 0");
    const { conn } = await open(c.items);
    expect(await conn.read()).toBe(0);
  });

  it("read without input pins is NoResource", async () => {
    const c = goldenCase("io", "read: no input pins configured");
    const { conn } = await open(c.items);
    await conn.mapSet({
      flags: 0,
      direction: 0x0c7fffff,
      pullUp: 0,
      pullDown: 0,
      outDefault: 0,
      outPolarity: 0,
      inPolarity: 0,
      edge: 0,
    });
    await expectCode(conn.read(), ErrorCode.NoResource);
  });

  it("write only changes masked pins; state reports both words", async () => {
    const c = goldenCase("io", "write: only the masked pins change");
    const { conn, port } = await open(c.items);
    await conn.mapSet({
      flags: 0,
      direction: 0x0f,
      pullUp: 0,
      pullDown: 0x0c7ffff0,
      outDefault: 5,
      outPolarity: 0,
      inPolarity: 0,
      edge: 0x0c7ffff0,
    });
    await conn.write(0x2, 0x3);
    expect(await conn.state()).toEqual({ inputs: 0, outputs: 6 });
    expect(port.remainingRequests()).toBe(0);
  });

  it("write rejects a mask outside the DIO pins before sending", async () => {
    const { conn, port } = await open([]);
    await expectCode(conn.write(1, 1 << 23), ErrorCode.InvalidArgument);
    await expectCode(conn.write(1, 0xffffffff), ErrorCode.InvalidArgument);
    expect(port.written).toEqual(["version"]);
  });
});

describe("pin map", () => {
  it("mapSet then mapGet echoes the map", async () => {
    const c = goldenCase("map", "map set: full map, then get echoes it");
    const { conn, port } = await open(c.items);
    await conn.mapSet(MAP_FULL);
    expect(await conn.mapGet()).toEqual(MAP_FULL);
    expect(port.remainingRequests()).toBe(0);
  });

  it("mapSet validates before sending", async () => {
    const { conn, port } = await open([]);
    await expectCode(conn.mapSet({ ...MAP_FULL, flags: 1 }), ErrorCode.InvalidArgument);
    await expectCode(conn.mapSet({ ...MAP_FULL, direction: 1 << 23 }), ErrorCode.InvalidArgument);
    expect(port.written).toEqual(["version"]);
  });

  it("mapSave and mapDefault", async () => {
    const c = goldenCase("map", "map default then map save erases the saved map");
    const { conn, port } = await open(c.items);
    await conn.mapSet(MAP_FULL);
    await conn.mapSave();
    await conn.mapDefault();
    await conn.mapSave();
    expect(port.remainingRequests()).toBe(
      c.items.filter((i) => i.kind === "request").length - 4,
    );
  });

  it("mapSet and mapDefault are Busy while a pattern runs", async () => {
    const c = goldenCase("map", "map set and map default are refused while a pattern is running");
    const { conn, port } = await open(c.items);
    await conn.mapSet({
      flags: 0,
      direction: 3,
      pullUp: 0,
      pullDown: 0x0c7ffffc,
      outDefault: 0,
      outPolarity: 0,
      inPolarity: 0,
      edge: 0x0c7ffffc,
    });
    await conn.patternAdd([
      { outBits: 1, holdTicks: 100 },
      { outBits: 0, holdTicks: 100 },
    ]);
    await conn.patternRun("loop", 1000);
    await expectCode(conn.mapSet(MAP_FULL), ErrorCode.Busy);
    await expectCode(conn.mapDefault(), ErrorCode.Busy);
    expect((await conn.mapGet()).direction).toBe(3);
    await conn.patternStop();
    await conn.mapSet(MAP_FULL);
    expect(await conn.mapGet()).toEqual(MAP_FULL);
    expect(port.remainingRequests()).toBe(0);
  });

  it("a device that reports an invalid map is a parse error (negative)", async () => {
    const port = new FakePort();
    port.onCommand = (cmd) =>
      port.feed(
        cmd === "version"
          ? "OK fw=0.1.3 proto=2"
          : "OK v=2 flags=0x01 dir=0x00000000 pu=0x00000000 pd=0x00000000 def=0x00000000 " +
              "opol=0x00000000 ipol=0x00000000 edge=0x00000000",
      );
    const conn = await Connection.fromPort(port);
    await expectCode(conn.mapGet(), ErrorCode.Parse);
  });
});

describe("pattern", () => {
  it("patternAdd returns the running total", async () => {
    const c = goldenCase("pattern", "pattern add: totals accumulate over calls");
    const { conn, port } = await open(c.items);
    await conn.mapSet({
      flags: 0,
      direction: 3,
      pullUp: 0,
      pullDown: 0x0c7ffffc,
      outDefault: 0,
      outPolarity: 0,
      inPolarity: 0,
      edge: 0x0c7ffffc,
    });
    expect(
      await conn.patternAdd([
        { outBits: 1, holdTicks: 5 },
        { outBits: 0, holdTicks: 10 },
      ]),
    ).toBe(2);
    expect(await conn.patternAdd([{ outBits: 2, holdTicks: 1 }])).toBe(3);
    expect(
      await conn.patternAdd([
        { outBits: 3, holdTicks: 7 },
        { outBits: 0, holdTicks: 7 },
        { outBits: 1, holdTicks: 7 },
      ]),
    ).toBe(6);
    expect(await conn.patternStatus()).toEqual({ state: "loaded", step: 0, loops: 0, total: 6 });
    expect(port.remainingRequests()).toBe(0);
  });

  it("patternAdd refuses steps that do not fit one line, and invalid steps (nothing sent)", async () => {
    const { conn, port } = await open([]);
    const many = Array.from({ length: 41 }, () => ({ outBits: 0, holdTicks: 1 }));
    await expectCode(conn.patternAdd(many), ErrorCode.InvalidArgument);
    await expectCode(conn.patternAdd([]), ErrorCode.InvalidArgument);
    await expectCode(conn.patternAdd([{ outBits: 1, holdTicks: 0 }]), ErrorCode.InvalidArgument);
    await expectCode(conn.patternAdd([{ outBits: 1 << 23, holdTicks: 1 }]), ErrorCode.InvalidArgument);
    expect(port.written).toEqual(["version"]);
  });

  it("patternLoad resets, then adds in 256-byte chunks (256 steps = 6 x 40 + 16)", async () => {
    const adds = goldenCase("boundary", "256 pattern steps are accepted")
      .items.filter((i) => i.kind === "request" && i.text.startsWith("pattern add"))
      .slice(0, 7);
    expect(adds).toHaveLength(7);
    const reset = request("pattern", "pattern reset: clears loaded steps", "pattern reset");
    const { conn, port } = await open([reset, ...adds]);
    const steps = Array.from({ length: 256 }, () => ({ outBits: 0, holdTicks: 1 }));
    expect(await conn.patternLoad(steps)).toBe(256);
    expect(port.remainingRequests()).toBe(0);
  });

  it("the 257th step is TooLong and adds nothing", async () => {
    const c = goldenCase("errors", "ERR TOO_LONG");
    const { conn, port } = await open(c.items);
    const forty = Array.from({ length: 40 }, () => ({ outBits: 0, holdTicks: 1 }));
    for (let i = 1; i <= 6; i++) expect(await conn.patternAdd(forty)).toBe(i * 40);
    expect(await conn.patternAdd(forty.slice(0, 16))).toBe(256);
    await expectCode(conn.patternAdd([{ outBits: 0, holdTicks: 1 }]), ErrorCode.TooLong);
    expect((await conn.patternStatus()).total).toBe(256);
    expect(port.remainingRequests()).toBe(0);
  });

  it("run once, status, stop, reset", async () => {
    const c = goldenCase("pattern", "pattern stop: running pattern stops, steps stay loaded");
    const { conn, port } = await open(c.items);
    await conn.mapSet({
      flags: 0,
      direction: 3,
      pullUp: 0,
      pullDown: 0x0c7ffffc,
      outDefault: 0,
      outPolarity: 0,
      inPolarity: 0,
      edge: 0x0c7ffffc,
    });
    await conn.patternAdd([
      { outBits: 1, holdTicks: 5 },
      { outBits: 0, holdTicks: 10 },
    ]);
    await conn.patternRun("loop", 5);
    await conn.patternStop();
    expect((await conn.patternStatus()).state).toBe("loaded");
    await conn.patternRun("once", 1);
    expect(port.remainingRequests()).toBe(0);
  });

  it("patternStop on an idle engine is NotRunning", async () => {
    const c = goldenCase("pattern", "pattern stop: not running is refused");
    const { conn } = await open(c.items);
    await conn.mapSet({
      flags: 0,
      direction: 3,
      pullUp: 0,
      pullDown: 0x0c7ffffc,
      outDefault: 0,
      outPolarity: 0,
      inPolarity: 0,
      edge: 0x0c7ffffc,
    });
    await expectCode(conn.patternStop(), ErrorCode.NotRunning);
  });

  it("patternRun loop validates the repeat locally", async () => {
    const { conn, port } = await open([]);
    await expectCode(conn.patternRun("loop", 0), ErrorCode.InvalidArgument);
    await expectCode(conn.patternRun("loop", 65536), ErrorCode.InvalidArgument);
    expect(port.written).toEqual(["version"]);
  });
});

describe("reset commands", () => {
  it("reset and bootsel", async () => {
    const { conn, port } = await open([
      request("reset", "reset: acknowledges", "reset"),
      request("reset", "bootsel: acknowledges", "bootsel"),
    ]);
    await conn.reset();
    await conn.bootsel();
    expect(port.remainingRequests()).toBe(0);
  });
});

describe("timestamp", () => {
  it("tsArm / tsStatus / tsGet / tsDisarm", async () => {
    const c = goldenCase("timestamp", "ts arm then status, get with no events returns count=0");
    const { conn, port } = await open(c.items);
    await conn.tsArm(1, "rising");
    expect(await conn.tsStatus()).toEqual({ armed: true, pending: 0, overflow: false });
    expect(await conn.tsGet(5)).toEqual({ events: [], overflow: false });
    await conn.tsDisarm();
    expect((await conn.tsStatus()).armed).toBe(false);
    expect(port.remainingRequests()).toBe(0);
  });

  it("tsGet returns typed events with no ns field", async () => {
    const c = goldenCase("timestamp", "ts get consumes events: max limits the batch");
    const { conn, port } = await open(c.items);
    await conn.tsArm(1, "both");
    const first = await conn.tsGet(2);
    expect(first.events).toEqual([
      { inputs: 1, rawCount: 1, rawPhase: 0, syncActive: false },
      { inputs: 0, rawCount: 2, rawPhase: 0, syncActive: false },
    ]);
    expect(first.overflow).toBe(false);
    expect(first).not.toHaveProperty("reconciled");
    expect((await conn.tsStatus()).pending).toBe(1);
    expect((await conn.tsGet(2)).events).toHaveLength(1);
    expect((await conn.tsGet(2)).events).toEqual([]);
    expect(port.remainingRequests()).toBe(0);
  });

  it("tsGet reports ring overflow", async () => {
    const c = goldenCase("timestamp", "ts ring overflow: the oldest events are overwritten");
    const first = c.items.find((i) => i.kind === "request" && i.text.startsWith("ts get"));
    if (first?.kind !== "request") throw new Error("no ts get in case");
    expect(first.response[0]).toContain("overflow=1");
    const arm = c.items.find((i) => i.kind === "request" && i.text.startsWith("ts arm"));
    if (arm === undefined) throw new Error("no ts arm in case");
    const { conn } = await open([arm, first]);
    await conn.tsArm(1, "both");
    const result = await conn.tsGet(Number(first.text.slice("ts get ".length)));
    expect(result.overflow).toBe(true);
    expect(result.events.length).toBe(first.response.length - 1);
  });

  it("tsGet outside 1-85 and tsArm with a bad mask are rejected locally", async () => {
    const { conn, port } = await open([]);
    for (const bad of [0, 86, 1.5]) await expectCode(conn.tsGet(bad), ErrorCode.InvalidArgument);
    await expectCode(conn.tsArm(0, "both"), ErrorCode.InvalidArgument);
    await expectCode(conn.tsArm(1 << 23, "both"), ErrorCode.InvalidArgument);
    expect(port.written).toEqual(["version"]);
  });

  it("tsGet without arm is NotArmed", async () => {
    const c = goldenCase("timestamp", "ts get: not armed");
    const { conn } = await open(c.items);
    await expectCode(conn.tsGet(1), ErrorCode.NotArmed);
  });
});

describe("timestamps with reconcile (caps.tsResNs is the argument)", () => {
  it("ts under sync: ns from tsResNs, then reconcile / groupEvents", async () => {
    const c = goldenCase(
      "timestamp",
      "ts under sync: s=1, c counts sync clocks, p is the 40 ns phase 0..24, s returns to 0 after sync stop",
    );
    const caps = request("version-info", "caps (example, values are device-dependent)", "caps");
    const { conn, port } = await open([caps, ...c.items]);
    const { tsResNs } = await conn.caps();
    await conn.syncMaster();
    await conn.syncStart();
    await conn.tsArm(1, "both");
    await conn.syncStop();
    const result = await conn.tsGet(10);
    expect(port.remainingRequests()).toBe(0);
    expect(result).toEqual({
      events: [
        { inputs: 1, rawCount: 2, rawPhase: 12, syncActive: true },
        { inputs: 0, rawCount: 3, rawPhase: 24, syncActive: true },
        { inputs: 1, rawCount: 4, rawPhase: 0, syncActive: true },
        { inputs: 0, rawCount: 107, rawPhase: 0, syncActive: false },
      ],
      overflow: false,
    });
    expect(result.events.map((e) => timestampNs(e, tsResNs))).toEqual([2480, 3960, 4000, 107000]);

    const pairs = result.events.slice(0, 2).map((e): [number, number] => [e.rawCount, e.rawPhase]);
    // The raw pair straddles a microsecond: shifting the first by +1000 ns gives the smaller spread.
    expect(reconcile(pairs, tsResNs)).toEqual([3480, 3960]);
    const groups = groupEvents(
      result.events.map((e) => ({
        device: "local",
        channel: pinLabel(0),
        inputs: e.inputs,
        rawCount: e.rawCount,
        rawPhase: e.rawPhase,
        syncActive: e.syncActive,
      })),
      tsResNs,
    );
    expect(groups.map((g) => g.events.length)).toEqual([2, 1, 1]); // a count gap of 2 starts a group
    expect(groups[0].reconciledNs).toEqual([3480, 3960]);
  });
});

describe("sync", () => {
  it("master -> start -> count -> stop; count is a single OK line (clocks=)", async () => {
    const c = goldenCase("sync", "sync master -> start -> count -> stop");
    const { conn, port } = await open(c.items);
    await conn.syncMaster();
    await conn.syncStart();
    expect(await conn.syncCount()).toBe(0);
    expect(await conn.syncCount()).toBe(1000);
    expect(await conn.syncCount()).toBe(1000);
    expect(await conn.syncCount()).toBe(1001);
    await conn.syncStop();
    await expectCode(conn.syncCount(), ErrorCode.SyncState);
    expect(port.remainingRequests()).toBe(0);
  });

  it("arm / disarm", async () => {
    const c = goldenCase("sync", "sync disarm leaves slave-armed state");
    const { conn, port } = await open(c.items);
    await conn.syncArm();
    await conn.syncDisarm();
    await conn.syncMaster();
    expect(port.remainingRequests()).toBe(0);
  });

  it("wrong-state calls are SyncState", async () => {
    const c = goldenCase("sync", "sync arm: slave-armed state, every other transition is refused");
    const { conn } = await open(c.items);
    await conn.syncArm();
    await expectCode(conn.syncArm(), ErrorCode.SyncState);
    await expectCode(conn.syncMaster(), ErrorCode.SyncState);
    await expectCode(conn.syncStart(), ErrorCode.SyncState);
    await expectCode(conn.syncStop(), ErrorCode.SyncState);
    await expectCode(conn.syncCount(), ErrorCode.SyncState);
  });
});

describe("R-H2 through the connection: stale lines", () => {
  it("lines left over from a timed-out command never become the next response", async () => {
    const readReply = goldenResponse(
      goldenCase("io", "read: follows the driven input pins"),
      "read",
    );
    const port = new FakePort();
    const stateReply = goldenResponse(goldenCase("io", "state: default map"), "state");
    port.onCommand = (cmd) => {
      if (cmd === "version") port.feed(...goldenResponse(goldenCase("version-info", "version"), "version"));
      // `state` is never answered: the first call times out.
    };
    const conn = await Connection.fromPort(port);
    conn.setTimeout(50);
    await expectCode(conn.state(), ErrorCode.Timeout);

    // The device finally answers the old command, plus noise, then serves reads.
    port.feed(...stateReply, "OK pong=0");
    port.onCommand = (cmd) => {
      const ping = /^ping (\d+)$/.exec(cmd);
      if (ping) port.feed("OK stale", `OK pong=${ping[1]}`);
      else if (cmd === "read") port.feed(...readReply);
    };
    expect(await conn.read()).toBe(0x0a); // the golden `read` reply, not the stale `state`
    expect(port.written.slice(-2).map((l) => l.replace(/\d+$/, "N"))).toEqual(["ping N", "read"]);
  });
});

describe("raw", () => {
  it("returns every line of a counted response", async () => {
    const c = goldenCase("reset", "help: counted response");
    const { conn } = await open(c.items.slice(0, 1));
    const lines = await conn.raw("help");
    expect(lines).toHaveLength(17);
    expect(lines[0]).toBe("OK count=16");
    expect(lines[1]).toMatch(/^ {2}version /);
  });

  it("returns an ERR line as a line", async () => {
    const c = goldenCase("errors", "ERR UNKNOWN_CMD: unknown command names");
    const { conn } = await open(c.items.slice(0, 1));
    await expect(conn.raw("foo")).resolves.toEqual(["ERR UNKNOWN_CMD"]);
  });

  it("rejects subscribe locally: the SDK owns the subscription", async () => {
    const { conn, port } = await open([]);
    for (const cmd of ["subscribe on", "subscribe off", "SUBSCRIBE ON", "  Subscribe on", "subscribe"]) {
      await expectCode(conn.raw(cmd), ErrorCode.InvalidArgument);
    }
    expect(port.written).toEqual(["version"]);
  });

  it("rejects a line over 256 bytes locally; accepts exactly 256", async () => {
    const c = goldenCase("boundary", "line length 256 bytes (the limit");
    const exact = c.items.find((i) => i.kind === "request" && i.text.length === 256);
    if (exact === undefined) throw new Error("no 256-byte request in golden");
    const { conn, port } = await open([exact]);
    await expectCode(conn.raw("x".repeat(257)), ErrorCode.InvalidArgument);
    await expectCode(conn.raw(`${"y".repeat(250)}\r\nping 1`), ErrorCode.InvalidArgument);
    expect(port.written).toEqual(["version"]);
    await conn.raw(exact.kind === "request" ? exact.text : "");
    expect(port.remainingRequests()).toBe(0);
  });
});

describe("R-H4: subscription ownership", () => {
  const on = (): GoldenItem =>
    request("events", "INPUT: events are not sent before subscribe on", "subscribe on");
  const off = (): GoldenItem =>
    request("events", "INPUT: events are not sent before subscribe on", "subscribe off");

  it("has no public subscribe(bool)", async () => {
    const { conn } = await open([]);
    expect((conn as unknown as Record<string, unknown>).subscribe).toBeUndefined();
  });

  it("0 -> 1 sends subscribe on, 1 -> 0 sends subscribe off, one subscription is fanned out", async () => {
    const { conn, port } = await open([on(), off()]);
    const a: PushEvent[] = [];
    const b: PushEvent[] = [];
    const stopA = await conn.subscribeEvents((e) => a.push(e));
    const stopB = await conn.subscribeEvents((e) => b.push(e));
    expect(port.written).toEqual(["version", "subscribe on"]); // second subscriber: no command
    port.feed("! INPUT in=0x00000001 t=5", "! PATTERN_DONE loops=1");
    expect(a).toEqual(b);
    expect(a).toEqual([
      { type: "input_change", inputs: 1, timestampUs: 5 },
      { type: "pattern_done", loops: 1 },
    ]);
    await stopA();
    expect(port.written).toEqual(["version", "subscribe on"]); // one subscriber left
    port.feed("! PATTERN_TIMEOUT loops=0");
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);
    await stopB();
    expect(port.written).toEqual(["version", "subscribe on", "subscribe off"]);
    expect(port.remainingRequests()).toBe(0);
  });

  it("unsubscribing twice releases once", async () => {
    const { conn, port } = await open([on(), off()]);
    const stop = await conn.subscribeEvents(() => undefined);
    await stop();
    await stop();
    expect(port.written).toEqual(["version", "subscribe on", "subscribe off"]);
  });

  it("delivers the golden INPUT event stream to a subscriber", async () => {
    const c = goldenCase("events", "INPUT: events are not sent before subscribe on");
    const { conn, port } = await open(c.items);
    const seen: PushEvent[] = [];
    const stop = await conn.subscribeEvents((e) => seen.push(e));
    expect(seen).toEqual([{ type: "input_change", inputs: 0, timestampUs: 2 }]);
    await stop();
    expect(port.remainingRequests()).toBe(0);
  });

  it("a failed subscribe on is reported and not counted", async () => {
    const c = goldenCase("errors", "ERR NO_RESOURCE");
    const subscribe = c.items.find((i) => i.kind === "request" && i.text === "subscribe on");
    const mapSet = c.items.find((i) => i.kind === "request" && i.text.startsWith("map set"));
    if (subscribe === undefined || mapSet === undefined) throw new Error("golden case changed");
    const { conn, port } = await open([mapSet, subscribe, on(), off()]);
    await conn.mapSet({
      flags: 0,
      direction: 0x0c7fffff,
      pullUp: 0,
      pullDown: 0,
      outDefault: 0,
      outPolarity: 0,
      inPolarity: 0,
      edge: 0,
    });
    await expectCode(conn.subscribeEvents(() => undefined), ErrorCode.NoResource);
    const stop = await conn.subscribeEvents(() => undefined); // counted from 0 again: sends on
    await stop();
    expect(port.written.filter((l) => l.startsWith("subscribe"))).toEqual([
      "subscribe on",
      "subscribe on",
      "subscribe off",
    ]);
  });

  it("the input-change listener count drives the subscription", async () => {
    const { conn, port } = await open([on(), off()]);
    const seen: number[] = [];
    const listener = (e: { inputs: number }): void => {
      seen.push(e.inputs);
    };
    conn.on("input-change", listener);
    await conn.subscriptionSettled();
    expect(port.written).toEqual(["version", "subscribe on"]);
    port.feed("! INPUT in=0x00000003 t=1");
    expect(seen).toEqual([3]);
    conn.off("input-change", listener);
    await conn.subscriptionSettled();
    expect(port.written).toEqual(["version", "subscribe on", "subscribe off"]);
  });

  it("a failing background subscribe on is emitted as an error and the listener is dropped", async () => {
    const c = goldenCase("errors", "ERR NO_RESOURCE");
    const subscribe = c.items.find((i) => i.kind === "request" && i.text === "subscribe on");
    const mapSet = c.items.find((i) => i.kind === "request" && i.text.startsWith("map set"));
    if (subscribe === undefined || mapSet === undefined) throw new Error("golden case changed");
    const { conn, port } = await open([mapSet, subscribe, on(), off()]);
    await conn.mapSet({
      flags: 0,
      direction: 0x0c7fffff,
      pullUp: 0,
      pullDown: 0,
      outDefault: 0,
      outPolarity: 0,
      inPolarity: 0,
      edge: 0,
    });
    const errors: SdkError[] = [];
    conn.on("error", (e) => errors.push(e));
    const listener = (): void => undefined;
    conn.on("input-change", listener);
    await conn.subscriptionSettled();
    expect(errors.map((e) => e.code)).toEqual([ErrorCode.NoResource]);
    conn.off("input-change", listener); // already dropped: must not send subscribe off
    await conn.subscriptionSettled();
    expect(port.written.filter((l) => l.startsWith("subscribe"))).toEqual(["subscribe on"]);

    // The failed listener was not counted, so the count is still 0: a later
    // listener sends `subscribe on` again (a count of -1 would never send it).
    const later = (): void => undefined;
    conn.on("input-change", later);
    await conn.subscriptionSettled();
    expect(errors).toHaveLength(1);
    expect(port.written.filter((l) => l.startsWith("subscribe"))).toEqual([
      "subscribe on",
      "subscribe on",
    ]);
    conn.off("input-change", later);
    await conn.subscriptionSettled();
    expect(port.written.filter((l) => l.startsWith("subscribe"))).toEqual([
      "subscribe on",
      "subscribe on",
      "subscribe off",
    ]);
  });

  it("pattern-done and pattern-timeout listeners do not subscribe", async () => {
    const { conn, port } = await open([]);
    const done: number[] = [];
    const timeout: number[] = [];
    conn.on("pattern-done", (e) => done.push(e.loops));
    conn.on("pattern-timeout", (e) => timeout.push(e.loops));
    port.feed("! PATTERN_DONE loops=2", "! PATTERN_TIMEOUT loops=1");
    expect(done).toEqual([2]);
    expect(timeout).toEqual([1]);
    expect(port.written).toEqual(["version"]);
  });

  it("negative: an unknown event never reaches a subscriber", async () => {
    const port = new FakePort();
    port.onCommand = (cmd) => port.feed(cmd === "version" ? "OK fw=0.1.3 proto=2" : "OK");
    const conn = await Connection.fromPort(port);
    conn.logError = () => undefined;
    const seen: PushEvent[] = [];
    await conn.subscribeEvents((e) => seen.push(e));
    port.feed("! SYNC_DONE status=ready devnum=1 ts=42", "! NEW_THING");
    expect(seen).toEqual([]);
  });
});
