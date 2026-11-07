/**
 * Watchdog heartbeat (docs/sdk-api-design.md "Heartbeat"). Mirrors the tests
 * of `sdk/rust/src/heartbeat.rs`: period, distinct ping values, one failure
 * that is reported once and never retried, serialisation with the caller's
 * commands, and "closing changes nothing".
 */
import { describe, expect, it } from "vitest";
import { Connection } from "../src/connection.js";
import { ErrorCode, SdkError } from "../src/errors.js";
import { heartbeatPeriodMs } from "../src/heartbeat.js";
import { EchoPort, pongFor } from "./helpers/echo-port.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(port: EchoPort, timeoutMs = 300): Promise<Connection> {
  const conn = await Connection.fromPort(port);
  conn.setTimeout(timeoutMs);
  return conn;
}

describe("heartbeatPeriodMs", () => {
  it("is a quarter of the timeout, at most one second", () => {
    for (const [timeout, period] of [
      [100, 25],
      [101, 25],
      [400, 100],
      [3999, 999],
      [4000, 1000],
      [4001, 1000],
      [10_000, 1000],
    ]) {
      expect(heartbeatPeriodMs(timeout), `timeout ${timeout}`).toBe(period);
    }
  });

  it("refuses a disabled or out-of-range timeout", () => {
    for (const bad of [0, 1, 99, 10_001, 4_294_967_295, -1, 100.5, Number.NaN]) {
      try {
        heartbeatPeriodMs(bad);
      } catch (err) {
        expect((err as SdkError).code, String(bad)).toBe(ErrorCode.InvalidArgument);
        continue;
      }
      throw new Error(`${bad} was accepted`);
    }
  });
});

describe("Connection.startHeartbeat", () => {
  it("a disabled timeout starts nothing and sends nothing", async () => {
    const port = new EchoPort();
    const conn = await connect(port);
    expect(() => conn.startHeartbeat(0)).toThrow(SdkError);
    expect(port.commands).toEqual(["version"]);
    await conn.close();
  });

  it("pings every period with distinct values, starting at 0, until stopped", async () => {
    const port = new EchoPort();
    const conn = await connect(port);
    const hb = conn.startHeartbeat(100);
    expect(hb.periodMs).toBe(25);
    // The first ping is one period after the start.
    expect(port.pings()).toEqual([]);
    await sleep(300);
    expect(hb.isRunning).toBe(true);
    expect(hb.failure).toBeUndefined();
    await hb.stop();
    expect(hb.isRunning).toBe(false);

    const sent = port.pings();
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent[0]).toBe("ping 0");
    expect(new Set(sent).size).toBe(sent.length);
    // Stopped: nothing more arrives.
    await sleep(100);
    expect(port.pings()).toEqual(sent);
    await conn.close();
  });

  it("a failure is reported once through the error event and never retried", async () => {
    const port = new EchoPort();
    let answered = 0;
    port.pingReply = (n) => (answered++ === 1 ? ["ERR BUSY"] : [pongFor(n)]);
    const conn = await connect(port);
    const hb = conn.startHeartbeat(100);
    const events: SdkError[] = [];
    hb.on("error", (err) => events.push(err));

    const failure = await hb.waitFailure(2000);
    expect(failure?.code).toBe(ErrorCode.Busy);
    expect(events).toEqual([failure]);
    expect(hb.failure).toBe(failure);
    // Many periods later: no third ping, and the heartbeat has ended.
    await sleep(250);
    expect(port.pings()).toHaveLength(2);
    expect(hb.isRunning).toBe(false);
    expect(events).toHaveLength(1);
    await conn.close();
  });

  it("a failure without an error listener is kept, not thrown", async () => {
    const port = new EchoPort();
    port.pingReply = () => ["ERR BUSY"];
    const conn = await connect(port);
    const hb = conn.startHeartbeat(100);
    expect((await hb.waitFailure(2000))?.code).toBe(ErrorCode.Busy);
    expect(hb.failure?.code).toBe(ErrorCode.Busy);
    await conn.close();
  });

  it("negative: a wrong pong is a failure", async () => {
    const port = new EchoPort();
    port.pingReply = (n) => [pongFor(n + 1)];
    const conn = await connect(port);
    const hb = conn.startHeartbeat(100);
    expect((await hb.waitFailure(2000))?.code).toBe(ErrorCode.Parse);
    await conn.close();
  });

  it("a silent device fails the heartbeat with a timeout", async () => {
    const port = new EchoPort();
    port.pingReply = () => [];
    const conn = await connect(port, 60);
    const hb = conn.startHeartbeat(100);
    expect((await hb.waitFailure(2000))?.code).toBe(ErrorCode.Timeout);
    expect(hb.isRunning).toBe(false);
    await conn.close();
  });

  it("a device that went away is a Disconnected failure", async () => {
    const port = new EchoPort();
    const conn = await connect(port);
    const hb = conn.startHeartbeat(100);
    await sleep(60);
    port.close(); // unplugged: the port closes under the connection
    expect((await hb.waitFailure(2000))?.code).toBe(ErrorCode.Disconnected);
  });

  it("waitFailure times out with undefined while the heartbeat is healthy", async () => {
    const port = new EchoPort();
    const conn = await connect(port);
    const hb = conn.startHeartbeat(100);
    expect(await hb.waitFailure(80)).toBeUndefined();
    expect(hb.isRunning).toBe(true);
    await hb.stop();
    await conn.close();
  });

  it("the caller's commands are never mixed with heartbeat pings", async () => {
    const port = new EchoPort((cmd) => {
      if (cmd === "excl get") return ["OK count=2", "  mask=0x0000000c", "  mask=0x00000018"];
      return undefined;
    });
    const conn = await connect(port, 1000);
    const hb = conn.startHeartbeat(100);
    // A counted response and plain responses, over and over while the heartbeat
    // fires every 25 ms: every one must get its own answer.
    const end = Date.now() + 400;
    let n = 0;
    while (Date.now() < end) {
      const [masks, echoed] = await Promise.all([conn.exclGet(), conn.ping(1_000_000 + n)]);
      expect(masks).toEqual([0xc, 0x18]);
      expect(echoed).toBe(1_000_000 + n);
      n++;
      // A fake port answers within one tick: yield to the timers so the heartbeat can fire.
      await sleep(2);
    }
    expect(n).toBeGreaterThan(5);
    expect(hb.failure, "heartbeat saw a bad exchange").toBeUndefined();
    expect(hb.isRunning).toBe(true);
    const heartbeatPings = port.pings().filter((p) => Number(p.slice(5)) < 1_000_000);
    expect(heartbeatPings.length).toBeGreaterThanOrEqual(4);
    await conn.close();
  });

  it("closing the connection ends the heartbeat silently, with no command", async () => {
    const port = new EchoPort();
    const conn = await connect(port);
    const hb = conn.startHeartbeat(100);
    await sleep(80);
    await conn.close();
    expect(hb.isRunning).toBe(false);
    expect(hb.failure, "a closed connection is not a failure").toBeUndefined();
    const before = [...port.commands];
    await sleep(100);
    expect(port.commands).toEqual(before);
    expect(port.commands.every((c) => c === "version" || c.startsWith("ping "))).toBe(true);
  });

  it("stopping sends no command and leaves the connection usable", async () => {
    const port = new EchoPort();
    const conn = await connect(port);
    const hb = conn.startHeartbeat(100);
    await sleep(60);
    await hb.stop();
    await hb.stop(); // idempotent
    expect(port.commands.every((c) => c === "version" || c.startsWith("ping "))).toBe(true);
    expect(await conn.ping(7)).toBe(7);
    await conn.close();
  });

  it("a ping that is in flight when the heartbeat stops is not reported", async () => {
    const port = new EchoPort();
    port.pingReply = () => []; // never answered
    const conn = await connect(port, 150);
    const hb = conn.startHeartbeat(100);
    await sleep(40); // the first ping is out and waiting
    const events: SdkError[] = [];
    hb.on("error", (err) => events.push(err));
    await hb.stop();
    expect(hb.failure).toBeUndefined();
    expect(events).toEqual([]);
    await conn.close();
  });
});
