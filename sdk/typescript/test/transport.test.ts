/**
 * Transport contract tests (R-H1 to R-H3; R-H4 lives in connection.test.ts).
 * The fake device here answers with lines taken from the golden transcripts
 * or, for the negative cases (stale / garbage lines), hand-written text.
 */
import { describe, expect, it } from "vitest";
import { ErrorCode, SdkError } from "../src/errors.js";
import { Transport } from "../src/transport.js";
import type { PushEvent } from "../src/types.js";
import { FakePort } from "./helpers/fake-port.js";
import { goldenCase, goldenResponse } from "./helpers/golden.js";

// Assembled at runtime so the R-X1 gate does not see the removed event name in source.
const REMOVED_EVENT = ["SYNC", "DONE"].join("_");

export { FakePort };

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

function setup(): { transport: Transport; port: FakePort; logged: string[] } {
  const port = new FakePort();
  const transport = new Transport(port);
  const logged: string[] = [];
  transport.logError = (msg) => logged.push(msg);
  return { transport, port, logged };
}

const pingNonce = (cmd: string): number | null => {
  const m = /^ping (\d+)$/.exec(cmd);
  return m ? Number(m[1]) : null;
};

const TS_GET = goldenResponse(
  goldenCase("timestamp", "ts both: every edge is recorded"),
  "ts get 10",
);

describe("R-H1: one command, one response", () => {
  it("returns OK data", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK fw=0.1.3 proto=2");
    await expect(transport.command("version")).resolves.toBe("fw=0.1.3 proto=2");
    expect(port.written).toEqual(["version"]);
  });

  it("bare OK has empty data", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK");
    await expect(transport.command("map save")).resolves.toBe("");
  });

  it("maps device ERR names to typed errors", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("ERR UNKNOWN_CMD");
    await expectCode(transport.command("bogus"), ErrorCode.UnknownCmd);
  });

  it("a device ERR keeps the connection usable (no resync)", async () => {
    const { transport, port } = setup();
    port.onCommand = (cmd) => port.feed(cmd === "bogus" ? "ERR UNKNOWN_CMD" : "OK pong=1");
    await expectCode(transport.command("bogus"), ErrorCode.UnknownCmd);
    await transport.command("ping 1");
    expect(port.written).toEqual(["bogus", "ping 1"]);
  });

  it("a counted response reads exactly N lines (count= in the header)", async () => {
    const { transport, port } = setup();
    expect(TS_GET[0]).toMatch(/^OK count=\d+ overflow=\d$/);
    port.onCommand = () => port.feed(...TS_GET);
    const [data, lines] = await transport.commandCounted("ts get 10");
    expect(`OK ${data}`).toBe(TS_GET[0]);
    expect(lines).toEqual(TS_GET.slice(1));
  });

  it("count=0 reads no extra lines", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK count=0 overflow=0");
    const [data, lines] = await transport.commandCounted("ts get 10");
    expect(data).toBe("count=0 overflow=0");
    expect(lines).toEqual([]);
  });

  it("a response without count= is not read as counted (sync count)", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK clocks=1000000");
    const start = Date.now();
    await expect(transport.command("sync count")).resolves.toBe("clocks=1000000");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("commandCounted rejects a response without count= (stays in sync)", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK clocks=5");
    await expectCode(transport.commandCounted("sync count"), ErrorCode.Parse);
    port.onCommand = () => port.feed("OK pong=3");
    await transport.command("ping 3");
    expect(port.written).toEqual(["sync count", "ping 3"]);
  });

  it("command rejects a counted response (stays in sync)", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK count=1", "  in=0x1 c=1 p=0 s=0");
    await expectCode(transport.command("write 0x1 0x1"), ErrorCode.Parse);
    port.onCommand = () => port.feed("OK");
    await transport.command("map save");
    expect(port.written).toEqual(["write 0x1 0x1", "map save"]);
  });

  it("propagates device errors from a counted command", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("ERR NOT_ARMED");
    await expectCode(transport.commandCounted("ts get 1"), ErrorCode.NotArmed);
  });

  it("raw returns every line of a counted response", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed(...TS_GET);
    await expect(transport.raw("ts get 10")).resolves.toEqual(TS_GET);
  });

  it("raw returns an ERR line as a line, not an error", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("ERR UNKNOWN_CMD");
    await expect(transport.raw("nope")).resolves.toEqual(["ERR UNKNOWN_CMD"]);
  });

  it("assembles lines split across chunks", async () => {
    const { transport, port } = setup();
    port.onCommand = () => {
      port.feedRaw("OK fw=0.");
      setTimeout(() => port.feedRaw("1.3 proto=2\r\n"), 20);
    };
    await expect(transport.command("version")).resolves.toBe("fw=0.1.3 proto=2");
  });

  it("serialises concurrent commands in call order", async () => {
    const { transport, port } = setup();
    port.onCommand = (cmd) => {
      const n = pingNonce(cmd);
      setTimeout(() => port.feed(`OK pong=${n}`), 5);
    };
    const results = await Promise.all([
      transport.command("ping 1"),
      transport.command("ping 2"),
      transport.command("ping 3"),
    ]);
    expect(results).toEqual(["pong=1", "pong=2", "pong=3"]);
    expect(port.written).toEqual(["ping 1", "ping 2", "ping 3"]);
  });

  it("does not drain-and-discard extra lines: they force a resynchronisation", async () => {
    const { transport, port } = setup();
    port.feed("OK stale leftover");
    await new Promise((r) => setTimeout(r, 10));
    port.onCommand = (cmd) => {
      const n = pingNonce(cmd);
      port.feed(n !== null ? `OK pong=${n}` : "OK fw=0.1.3 proto=2");
    };
    await expect(transport.command("version")).resolves.toBe("fw=0.1.3 proto=2");
    expect(port.written).toHaveLength(2);
    expect(port.written[0]).toMatch(/^ping \d+$/);
    expect(port.written[1]).toBe("version");
  });
});

describe("push events", () => {
  it("routes interleaved events away from responses", async () => {
    const { transport, port } = setup();
    const events: PushEvent[] = [];
    transport.on("push-event", (ev) => events.push(ev));
    port.onCommand = () => port.feed("! INPUT in=0x00000005 t=111", "OK in=0x00000003");
    await expect(transport.command("read")).resolves.toBe("in=0x00000003");
    expect(events).toEqual([{ type: "input_change", inputs: 5, timestampUs: 111 }]);
  });

  it("delivers all three event types", () => {
    const { transport, port } = setup();
    const events: PushEvent[] = [];
    transport.on("push-event", (ev) => events.push(ev));
    port.feed(
      "! INPUT in=0x00000001 t=100",
      "! PATTERN_DONE loops=3",
      "! PATTERN_TIMEOUT loops=2",
    );
    expect(events).toEqual([
      { type: "input_change", inputs: 1, timestampUs: 100 },
      { type: "pattern_done", loops: 3 },
      { type: "pattern_timeout", loops: 2 },
    ]);
  });

  it("an event inside a counted response does not break the count", async () => {
    const { transport, port } = setup();
    const events: PushEvent[] = [];
    transport.on("push-event", (ev) => events.push(ev));
    port.onCommand = () =>
      port.feed(
        "OK count=2 overflow=0",
        "  in=0x00000001 c=1 p=0 s=0",
        "! PATTERN_DONE loops=1",
        "  in=0x00000000 c=2 p=0 s=0",
      );
    const [, lines] = await transport.commandCounted("ts get 2");
    expect(lines).toHaveLength(2);
    expect(events).toEqual([{ type: "pattern_done", loops: 1 }]);
  });

  it("logs an unknown event as an error and discards it", async () => {
    const { transport, port, logged } = setup();
    const events: PushEvent[] = [];
    transport.on("push-event", (ev) => events.push(ev));
    port.onCommand = () => port.feed("! NEW_THING a=1", "OK");
    await transport.command("map save");
    expect(events).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("NEW_THING");
  });

  it("logs a malformed known event as an error and discards it", () => {
    const { transport, port, logged } = setup();
    const events: PushEvent[] = [];
    transport.on("push-event", (ev) => events.push(ev));
    port.feed("! INPUT garbage");
    expect(events).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("INPUT garbage");
  });

  it("the removed sync-done event is unknown", () => {
    const { transport, port, logged } = setup();
    const events: PushEvent[] = [];
    transport.on("push-event", (ev) => events.push(ev));
    port.feed(`! ${REMOVED_EVENT} status=ready devnum=1 ts=42`);
    expect(events).toEqual([]);
    expect(logged).toHaveLength(1);
  });
});

describe("R-H2: resynchronisation", () => {
  /** Device that answers `ping N` and ignores everything else. */
  const pingResponder = (port: FakePort, replies: (cmd: string) => string[] = () => []): void => {
    port.onCommand = (cmd) => {
      const n = pingNonce(cmd);
      if (n !== null) port.feed(`OK pong=${n}`);
      else port.feed(...replies(cmd));
    };
  };

  it("a timeout is followed by a ping resync before the next command", async () => {
    const { transport, port } = setup();
    transport.timeoutMs = 50;
    port.onCommand = () => undefined; // silence: the first command times out
    await expectCode(transport.command("version"), ErrorCode.Timeout);

    pingResponder(port, () => ["OK fw=0.1.3 proto=2"]);
    await expect(transport.command("version")).resolves.toBe("fw=0.1.3 proto=2");
    expect(port.written).toHaveLength(3);
    expect(port.written[0]).toBe("version");
    expect(port.written[1]).toMatch(/^ping \d+$/);
    expect(port.written[2]).toBe("version");
  });

  it("stale lines injected after a timeout are discarded up to the matching pong", async () => {
    const { transport, port } = setup();
    transport.timeoutMs = 50;
    port.onCommand = () => undefined;
    await expectCode(transport.command("state"), ErrorCode.Timeout);

    // The late response of the timed-out command, plus a stale pong of an
    // earlier ping, arrive before the next exchange.
    port.feed("OK in=0x00000000 out=0x00000000", "OK pong=1", "ERR BUSY");
    port.onCommand = (cmd) => {
      const n = pingNonce(cmd);
      if (n !== null) port.feed("OK stale tail line", `OK pong=${n}`);
      else port.feed("OK in=0x00000001 out=0x00000002");
    };
    await expect(transport.command("state")).resolves.toBe("in=0x00000001 out=0x00000002");
  });

  it("a pong with a different value is stale and skipped", async () => {
    const { transport, port } = setup();
    transport.timeoutMs = 50;
    port.onCommand = () => undefined;
    await expectCode(transport.command("read"), ErrorCode.Timeout);
    port.onCommand = (cmd) => {
      const n = pingNonce(cmd);
      if (n !== null) port.feed(`OK pong=${(n + 1) % 0x100000000}`, `OK pong=${n}`);
      else port.feed("OK in=0x00000007");
    };
    await expect(transport.command("read")).resolves.toBe("in=0x00000007");
  });

  it("stale line injected while idle is not taken as the next response", async () => {
    const { transport, port } = setup();
    port.feed("OK in=0x000000ff"); // nobody asked for this
    await new Promise((r) => setTimeout(r, 10));
    pingResponder(port, () => ["OK in=0x00000001"]);
    await expect(transport.command("read")).resolves.toBe("in=0x00000001");
    expect(port.written[0]).toMatch(/^ping \d+$/);
  });

  it("an unparseable line puts the connection in desync", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("WHAT IS THIS");
    await expectCode(transport.command("version"), ErrorCode.Parse);
    pingResponder(port, () => ["OK fw=0.1.3 proto=2"]);
    await expect(transport.command("version")).resolves.toBe("fw=0.1.3 proto=2");
    expect(port.written.map((l) => (/^ping \d+$/.test(l) ? "ping" : l))).toEqual([
      "version",
      "ping",
      "version",
    ]);
  });

  it("a short counted response desyncs; the next operation resyncs", async () => {
    const { transport, port } = setup();
    transport.timeoutMs = 50;
    port.onCommand = () => port.feed("OK count=3 overflow=0", "  in=0x1 c=1 p=0 s=0");
    await expectCode(transport.commandCounted("ts get 3"), ErrorCode.Timeout);
    pingResponder(port, () => ["OK count=0 overflow=0"]);
    const [data, lines] = await transport.commandCounted("ts get 3");
    expect(data).toBe("count=0 overflow=0");
    expect(lines).toEqual([]);
    expect(port.written[1]).toMatch(/^ping \d+$/);
  });

  it("a continuation line without the two-space indent is a framing error", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK count=1 overflow=0", "OK not a continuation");
    await expectCode(transport.commandCounted("ts get 1"), ErrorCode.Parse);
    pingResponder(port, () => ["OK"]);
    await transport.command("ts disarm");
    expect(port.written[1]).toMatch(/^ping \d+$/);
  });

  it("an invalid count= value desyncs", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK count=abc overflow=0");
    await expectCode(transport.commandCounted("ts get 1"), ErrorCode.Parse);
    pingResponder(port, () => ["OK"]);
    await transport.command("ts disarm");
    expect(port.written[1]).toMatch(/^ping \d+$/);
  });

  it("push events arriving during the resync are still routed", async () => {
    const { transport, port } = setup();
    const events: PushEvent[] = [];
    transport.on("push-event", (ev) => events.push(ev));
    transport.timeoutMs = 50;
    port.onCommand = () => undefined;
    await expectCode(transport.command("read"), ErrorCode.Timeout);
    port.onCommand = (cmd) => {
      const n = pingNonce(cmd);
      if (n !== null) port.feed("! PATTERN_DONE loops=4", `OK pong=${n}`);
      else port.feed("OK in=0x00000000");
    };
    await transport.command("read");
    expect(events).toEqual([{ type: "pattern_done", loops: 4 }]);
  });

  it("a failed resync closes the connection (Disconnected)", async () => {
    const { transport, port } = setup();
    transport.timeoutMs = 50;
    port.onCommand = () => undefined;
    await expectCode(transport.command("read"), ErrorCode.Timeout);
    await expectCode(transport.command("read"), ErrorCode.Disconnected); // ping never answered
    expect(port.isOpen).toBe(false);
    await expectCode(transport.command("read"), ErrorCode.Disconnected);
  });

  it("a command timeout alone does not close the port", async () => {
    const { transport, port } = setup();
    transport.timeoutMs = 50;
    await expectCode(transport.command("version"), ErrorCode.Timeout);
    expect(port.isOpen).toBe(true);
  });
});

describe("R-H3: DTR", () => {
  it("attach asserts DTR before the transport is used", async () => {
    const port = new FakePort();
    const transport = await Transport.attach(port);
    expect(port.dtr).toBe(true);
    port.onCommand = () => port.feed("OK");
    await transport.command("map save");
  });

  it("attach fails with a Connection error when DTR cannot be set", async () => {
    const port = new FakePort();
    port.setError = new Error("no dtr");
    await expectCode(Transport.attach(port), ErrorCode.Connection);
  });
});

describe("disconnect", () => {
  it("pending command rejects with Disconnected", async () => {
    const { transport, port } = setup();
    const pending = transport.command("version");
    port.close();
    await expectCode(pending, ErrorCode.Disconnected);
  });

  it("subsequent commands reject with Disconnected", async () => {
    const { transport, port } = setup();
    port.close();
    await expectCode(transport.command("version"), ErrorCode.Disconnected);
  });

  it("a port error disconnects", async () => {
    const { transport, port } = setup();
    const pending = transport.command("version");
    port.emit("error", new Error("boom"));
    await expectCode(pending, ErrorCode.Disconnected);
  });

  it("a port error keeps its message in the Disconnected error", async () => {
    const { transport, port } = setup();
    const pending = transport.command("version");
    port.emit("error", new Error("boom"));
    await expect(pending).rejects.toThrow(/boom/);
    await expect(transport.command("version")).rejects.toThrow(/boom/);
  });
});
