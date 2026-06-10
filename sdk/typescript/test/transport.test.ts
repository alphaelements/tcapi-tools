import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ErrorCode, SdkError } from "../src/errors.js";
import { Transport, type PortLike } from "../src/transport.js";
import type { PushEvent } from "../src/types.js";

/** In-memory fake port: feeds scripted lines, records written commands. */
export class FakePort extends EventEmitter implements PortLike {
  written: string[] = [];
  isOpen = true;
  /** Called with each complete command line written by the host. */
  onCommand: ((cmd: string) => void) | null = null;
  private writeAcc = "";

  write(data: Buffer | string, cb?: (err?: Error | null) => void): boolean {
    this.writeAcc += data.toString();
    let idx: number;
    while ((idx = this.writeAcc.indexOf("\n")) >= 0) {
      const line = this.writeAcc.slice(0, idx).replace(/\r+$/, "");
      this.writeAcc = this.writeAcc.slice(idx + 1);
      this.written.push(line);
      this.onCommand?.(line);
    }
    cb?.(null);
    return true;
  }

  close(cb?: (err?: Error | null) => void): void {
    this.isOpen = false;
    this.emit("close");
    cb?.(null);
  }

  /** Simulate device → host data. */
  feed(...lines: string[]): void {
    for (const line of lines) {
      this.emit("data", Buffer.from(`${line}\r\n`));
    }
  }

  /** Simulate device → host raw bytes (no line ending added). */
  feedRaw(data: string): void {
    this.emit("data", Buffer.from(data));
  }
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

function setup(): { transport: Transport; port: FakePort } {
  const port = new FakePort();
  return { transport: new Transport(port), port };
}

describe("Transport.command", () => {
  it("returns OK data", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK v0.1.0 proto=1");
    await expect(transport.command("version")).resolves.toBe("v0.1.0 proto=1");
    expect(port.written).toEqual(["version"]);
  });

  it("maps device errors", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("ERR UNKNOWN_CMD");
    await expectCode(transport.command("bogus"), ErrorCode.BadCommand);
  });

  it("rejects garbage responses as parse errors", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("WHAT IS THIS");
    await expectCode(transport.command("version"), ErrorCode.Parse);
  });

  it("times out without a response", async () => {
    const { transport } = setup();
    transport.timeoutMs = 100;
    await expectCode(transport.command("version"), ErrorCode.Timeout);
  });

  it("routes interleaved push events away from responses", async () => {
    const { transport, port } = setup();
    const events: PushEvent[] = [];
    transport.on("push-event", (ev) => events.push(ev));
    port.onCommand = () => {
      port.feed("! INPUT 0x000005 t=111", "OK 0x000003");
    };
    await expect(transport.command("read")).resolves.toBe("0x000003");
    expect(events).toEqual([{ type: "input_change", inputs: 5, timestampUs: 111 }]);
  });

  it("drains stale lines before the next command", async () => {
    const { transport, port } = setup();
    port.feed("OK stale leftover");
    await new Promise((r) => setTimeout(r, 10));
    port.onCommand = () => port.feed("OK v0.1.0 proto=1");
    await expect(transport.command("version")).resolves.toBe("v0.1.0 proto=1");
  });

  it("assembles lines split across chunks", async () => {
    const { transport, port } = setup();
    port.onCommand = () => {
      port.feedRaw("OK v0.");
      setTimeout(() => port.feedRaw("1.0 proto=1\r\n"), 20);
    };
    await expect(transport.command("version")).resolves.toBe("v0.1.0 proto=1");
  });
});

describe("Transport.commandCounted", () => {
  it("reads exactly N lines", async () => {
    const { transport, port } = setup();
    port.onCommand = () =>
      port.feed("OK count=2", "  0x00000005 c=1000 p=7 s=1", "  0x0000000A c=2000 p=12 s=0");
    const [data, lines] = await transport.commandCounted("ts get 256");
    expect(data).toBe("count=2");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("c=1000");
  });

  it("count=0 reads no extra lines", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK count=0");
    const [data, lines] = await transport.commandCounted("ts get 256");
    expect(data).toBe("count=0");
    expect(lines).toEqual([]);
  });

  it("propagates device errors", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("ERR NOT_ARMED");
    await expectCode(transport.commandCounted("ts get 256"), ErrorCode.NotArmed);
  });
});

describe("sync count discipline", () => {
  it("plain command returns immediately (no counted read)", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("OK count=1000000");
    const start = Date.now();
    await expect(transport.command("sync count")).resolves.toBe("count=1000000");
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("Transport.raw", () => {
  it("returns the raw line, even for ERR", async () => {
    const { transport, port } = setup();
    port.onCommand = () => port.feed("ERR BAD_CMD");
    await expect(transport.raw("nope")).resolves.toBe("ERR BAD_CMD");
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
});

describe("push event stream", () => {
  it("delivers all event types", async () => {
    const { transport, port } = setup();
    const events: PushEvent[] = [];
    transport.on("push-event", (ev) => events.push(ev));
    port.feed(
      "! INPUT 0x000001 t=100",
      "! PATTERN_DONE loops=3",
      "! SYNC_DONE status=ready devnum=1 ts=42",
    );
    expect(events).toEqual([
      { type: "input_change", inputs: 1, timestampUs: 100 },
      { type: "pattern_done", loops: 3 },
      { type: "sync_done", status: "ready", devnum: 1, timestamp: 42 },
    ]);
  });

  it("delivers malformed push lines as unknown", async () => {
    const { transport, port } = setup();
    const events: PushEvent[] = [];
    transport.on("push-event", (ev) => events.push(ev));
    port.feed("! INPUT garbage");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("unknown");
    expect((events[0] as { raw: string }).raw).toContain("INPUT garbage");
  });
});
