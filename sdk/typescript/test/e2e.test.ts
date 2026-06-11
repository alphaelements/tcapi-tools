/**
 * End-to-end tests against a mock firmware (same scenarios as the Rust
 * PTY E2E in `sdk/rust/tests/pty_e2e.rs`, over an in-memory port).
 */
import { describe, expect, it } from "vitest";
import { Connection } from "../src/connection.js";
import { ErrorCode, SdkError } from "../src/errors.js";
import { FakePort } from "./transport.test.js";

/** Stateful mock FW mirroring the Rust MockFw. */
class MockFw {
  outputs = 0;
  inputs = 0x05;
  map = "v=1 out=0:12 in=12:11 pull=up flags=0x01";
  patternLoaded = 0;
  patternState = "idle";
  tsArmed = false;
  tsEvents = ["  0x00000005 c=1000 p=7 s=1", "  0x0000000A c=2000 p=12 s=0"];
  tsOverflow = false;
  syncClocking = false;
  oldFirmware = false;

  handle(cmd: string): string[] {
    const parts = cmd.trim().toLowerCase().split(/\s+/);
    const key = parts.join(" ");
    if (key === "version") return ["OK v0.1.0 proto=1"];
    if (key === "caps") {
      const tsRes = this.oldFirmware ? 1000 : 40;
      return [
        `OK dio=23 out=12 in=11 ts_res=${tsRes}ns pattern=256 ring=256 feat=0x00000001`,
      ];
    }
    if (key === "info") return ["OK uid=AABBCCDD11223344 devnum=42"];
    if (parts[0] === "devnum") return ["OK"];
    if (key === "read") return [`OK 0x${this.inputs.toString(16).padStart(6, "0")}`];
    if (parts[0] === "write") {
      const v = Number(parts[1]);
      const m = Number(parts[2]);
      if (Number.isNaN(v) || Number.isNaN(m)) return ["ERR BAD_PARAM"];
      this.outputs = (this.outputs & ~m) | (v & m);
      return ["OK"];
    }
    if (key === "state") {
      return [
        `OK in=0x${this.inputs.toString(16)} out=0x${this.outputs.toString(16)} flags=0x00`,
      ];
    }
    if (key === "map get") return [`OK ${this.map}`];
    if (parts[0] === "map" && parts[1] === "set") {
      const hex = parts[2] ?? "";
      if (hex.length !== 48) return ["ERR BAD_PARAM"];
      const bytes = Buffer.from(hex, "hex");
      const outEnd = bytes[1] + bytes[2];
      if (bytes[2] !== 0 && bytes[4] !== 0 && bytes[3] < outEnd) return ["ERR BAD_MAP"];
      const pull = bytes[5] === 0 ? "none" : bytes[5] === 1 ? "up" : "down";
      this.map = `v=${bytes[0]} out=${bytes[1]}:${bytes[2]} in=${bytes[3]}:${bytes[4]} pull=${pull} flags=0x${bytes[6].toString(16).padStart(2, "0")}`;
      return ["OK"];
    }
    if (key === "map save") return ["OK"];
    if (key === "map default") {
      this.map = "v=1 out=0:0 in=0:23 pull=down flags=0x01";
      return ["OK"];
    }
    if (parts[0] === "subscribe") return ["OK"];
    if (parts[0] === "pattern" && parts[1] === "load") {
      const bytes = Buffer.from(parts[2] ?? "", "hex");
      if (bytes.length < 10) return ["ERR BAD_PARAM"];
      const count = bytes.readUInt16LE(0);
      if (bytes.length !== 2 + count * 8) return ["ERR BAD_PARAM"];
      this.patternLoaded = count;
      this.patternState = "loaded";
      return [`OK accepted=${count}`];
    }
    if (parts[0] === "pattern" && parts[1] === "run") {
      if (this.patternLoaded === 0) return ["ERR BAD_PARAM"];
      if (parts[2] === "loop" && parts[3] === "0") return ["ERR BAD_PARAM"];
      if (this.patternState === "running") return ["ERR BUSY"];
      this.patternState = "running";
      return ["OK"];
    }
    if (key === "pattern stop") {
      if (this.patternLoaded > 0) this.patternState = "loaded";
      return ["OK"];
    }
    if (key === "pattern status") {
      return [`OK state=${this.patternState} step=0 loops=0`];
    }
    if (parts[0] === "ts" && parts[1] === "arm") {
      if (this.tsArmed) return ["ERR BUSY"];
      this.tsArmed = true;
      return ["OK"];
    }
    if (parts[0] === "ts" && parts[1] === "get") {
      if (!this.tsArmed) return ["ERR NOT_ARMED"];
      if (this.oldFirmware) return ["OK count=1", "  0x00000005 t=1234567890"];
      const max = Number(parts[2] ?? 0);
      const events = this.tsEvents.slice(0, max);
      const overflowFlag = this.tsOverflow ? 1 : 0;
      return [
        `OK count=${events.length} overflow=${overflowFlag}`,
        ...events,
      ];
    }
    if (key === "ts disarm") {
      this.tsArmed = false;
      return ["OK"];
    }
    if (key === "sync arm" || key === "sync master") return ["OK"];
    if (key === "sync start") {
      this.syncClocking = true;
      return ["OK"];
    }
    if (key === "sync stop") {
      this.syncClocking = false;
      return ["OK"];
    }
    if (key === "sync count") {
      // `OK count=N` with NO data lines (unlike `ts get`).
      return this.syncClocking ? ["OK count=1000000"] : ["ERR SYNC_STATE"];
    }
    if (key === "sync disarm") return ["OK"];
    return ["ERR UNKNOWN_CMD"];
  }
}

function connectMock(fw: MockFw, prePush: string[] = []): {
  conn: Connection;
  port: FakePort;
} {
  const port = new FakePort();
  port.onCommand = (cmd) => {
    port.feed(...prePush, ...fw.handle(cmd));
  };
  return { conn: Connection.fromPort(port), port };
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

describe("full command sweep", () => {
  it("exercises the complete API", async () => {
    const { conn } = connectMock(new MockFw());

    const version = await conn.version();
    expect(version).toEqual({ major: 0, minor: 1, patch: 0, protocolVersion: 1 });
    const caps = await conn.caps();
    expect(caps.maxDio).toBe(23);
    expect(caps.tsResolutionNs).toBe(40);
    expect(caps.protocolVersion).toBe(1);
    const info = await conn.info();
    expect(info.uid).toBe("AABBCCDD11223344");
    expect(info.deviceNumber).toBe(42);
    await conn.setDeviceNumber(7);

    expect(await conn.read()).toBe(0x05);
    await conn.write(0x0a, 0x0f);
    const state = await conn.state();
    expect(state.outputs).toBe(0x0a);

    const map = await conn.mapGet();
    expect(map.outCount).toBe(12);
    expect(map.pull).toBe("up");
    await conn.mapSet({ ...map, outCount: 8, inBase: 8, inCount: 15 });
    expect((await conn.mapGet()).outCount).toBe(8);
    await conn.mapSave();
    await conn.mapDefault();
    expect((await conn.mapGet()).inCount).toBe(23);

    expect(
      await conn.patternLoad([
        { outBits: 0x0f, holdUs: 100 },
        { outBits: 0, holdUs: 100 },
      ]),
    ).toBe(2);
    await conn.patternRun("loop", 10);
    expect((await conn.patternStatus()).state).toBe("running");
    await conn.patternStop();
    expect((await conn.patternStatus()).state).toBe("loaded");

    await conn.tsArm(0x07ff, "both");
    const result = await conn.tsGet(256);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].timestampNs).toBe(1_000_280);
    expect(result.reconciled).toBe(false);
    await conn.tsDisarm();

    await conn.syncMaster();
    await conn.syncStart();
    expect(await conn.syncCount()).toBe(1_000_000);
    await conn.syncStop();
    await conn.syncDisarm();

    expect(await conn.raw("version")).toBe("OK v0.1.0 proto=1");
    await conn.close();
  });
});

describe("typed device errors", () => {
  it("maps each ERR to its code", async () => {
    const { conn } = connectMock(new MockFw());
    await expectCode(conn.tsGet(10), ErrorCode.NotArmed);
    await expectCode(conn.syncCount(), ErrorCode.SyncState);
    await expectCode(conn.patternRun("once", 1), ErrorCode.BadParam);
    await expect(conn.raw("frobnicate")).resolves.toBe("ERR UNKNOWN_CMD");
  });

  it("loop repeat=0 is rejected by FW", async () => {
    const fw = new MockFw();
    const { conn } = connectMock(fw);
    await conn.patternLoad([{ outBits: 1, holdUs: 1 }]);
    await expectCode(conn.patternRun("loop", 0), ErrorCode.BadParam);
  });
});

describe("push events interleaved with commands", () => {
  it("emits typed events while commands succeed", async () => {
    const { conn } = connectMock(new MockFw(), [
      "! INPUT 0x000001 t=100",
      "! PATTERN_DONE loops=2",
    ]);
    const inputs: number[] = [];
    const patterns: number[] = [];
    conn.on("input-change", (ev) => inputs.push(ev.inputs));
    conn.on("pattern-done", (ev) => patterns.push(ev.loops));

    await conn.subscribe(true);
    expect(await conn.read()).toBe(0x05);

    expect(inputs).toEqual([1, 1]);
    expect(patterns).toEqual([2, 2]);
  });
});

describe("old firmware fails loudly", () => {
  it("caps ts_res=1000 -> UnsupportedFirmware", async () => {
    const fw = new MockFw();
    fw.oldFirmware = true;
    const { conn } = connectMock(fw);
    await expectCode(conn.caps(), ErrorCode.UnsupportedFirmware);
  });

  it("ts get t= format -> UnsupportedFirmware", async () => {
    const fw = new MockFw();
    fw.oldFirmware = true;
    const { conn } = connectMock(fw);
    await conn.tsArm(0x01, "rising");
    await expectCode(conn.tsGet(10), ErrorCode.UnsupportedFirmware);
  });
});

describe("empty ts ring", () => {
  it("count=0 leaves the connection healthy", async () => {
    const fw = new MockFw();
    fw.tsEvents = [];
    const { conn } = connectMock(fw);
    await conn.tsArm(0x01, "rising");
    const result = await conn.tsGet(256);
    expect(result.events).toEqual([]);
    expect(result.overflow).toBe(false);
    expect(await conn.read()).toBe(0x05);
  });
});

describe("ts overflow flag propagation", () => {
  it("FW overflow=1 surfaces as result.overflow=true", async () => {
    const fw = new MockFw();
    fw.tsOverflow = true;
    const { conn } = connectMock(fw);
    await conn.tsArm(0x0f, "rising");
    const result = await conn.tsGet(256);
    expect(result.overflow).toBe(true);
    expect(result.events.length).toBe(2);
  });
});

describe("reconcile pipeline from tsGet", () => {
  it("straddle pair corrects to zero diff", async () => {
    const fw = new MockFw();
    fw.tsEvents = ["  0x00000001 c=1001 p=2 s=1", "  0x00000003 c=1000 p=2 s=1"];
    const { conn } = connectMock(fw);
    await conn.tsArm(0x03, "rising");
    const result = await conn.tsGet(256);

    const { groupEvents } = await import("../src/reconcile.js");
    const groups = groupEvents(
      result.events.map((ev, i) => ({
        device: "local",
        channel: `GP${i}`,
        inputs: `0x${ev.inputs.toString(16).padStart(8, "0")}`,
        rawCount: ev.rawCount,
        rawPhase: ev.rawPhase,
        syncActive: ev.syncActive,
      })),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].reconciled).toBe(true);
    expect(groups[0].reconciledNs[0]).toBe(groups[0].reconciledNs[1]);
  });
});
