import { describe, expect, it } from "vitest";
import { MockDeviceCore } from "./mock-device-core";
import { PIN_MAP_DEFAULT, type WirePinMap } from "./pinmap";
import { VALID_DIO_MASK } from "./pins";

// Rig map: GP0-GP11 outputs, the rest inputs with pull-down and edge events.
const RIG: WirePinMap = {
  ...PIN_MAP_DEFAULT,
  direction: 0xfff,
  pull_down: (VALID_DIO_MASK & ~0xfff) >>> 0,
  edge: (VALID_DIO_MASK & ~0xfff) >>> 0,
};

function rig(): MockDeviceCore {
  return new MockDeviceCore({ flashMap: RIG, loopback: true });
}

describe("rig loopback", () => {
  it("wires the k-th output pin to the k-th input pin, GP26 included", () => {
    const dev = rig();
    dev.execute("write 0x1 0xfff"); // GP0 -> GP12
    expect(dev.inputs).toBe(0x1000);
    dev.execute("write 0x800 0xfff"); // GP11 -> GP26
    expect(dev.inputs).toBe(0x04000000);
  });

  it("leaves the spare input low (pull-down)", () => {
    const dev = rig();
    dev.execute("write 0xfff 0xfff");
    expect(dev.inputs).toBe(0x047ff000); // GP27 has no partner
  });

  it("idles unpartnered inputs high with pull-up", () => {
    const dev = new MockDeviceCore({
      flashMap: { ...RIG, pull_down: 0, pull_up: (VALID_DIO_MASK & ~0xfff) >>> 0 },
      loopback: true,
    });
    expect(dev.inputs).toBe(0x08000000);
  });

  it("applies output polarity: the loopback carries the physical level", () => {
    const dev = new MockDeviceCore({ flashMap: { ...RIG, out_polarity: 0x1 }, loopback: true });
    // logical 0 on GP0 with opol drives the pin high
    expect(dev.inputs).toBe(0x1000);
    dev.execute("write 0x1 0x1");
    expect(dev.inputs).toBe(0);
  });

  it("raises ! INPUT events for loopback edges only after subscribe on", () => {
    const dev = rig();
    dev.execute("write 0x1 0x1");
    expect(dev.takeEvents()).toEqual([]);
    expect(dev.execute("subscribe on")).toEqual(["OK"]);
    dev.execute("write 0x0 0x1");
    expect(dev.takeEvents()).toEqual(["! INPUT in=0x00000000 t=0"]);
  });

  it("captures timestamps for loopback edges while armed", () => {
    const dev = rig();
    expect(dev.execute("ts arm 0x1000 rising")).toEqual(["OK"]);
    dev.advance(5000);
    dev.execute("write 0x1 0x1");
    expect(dev.execute("ts get 10")).toEqual([
      "OK count=1 overflow=0",
      "  in=0x00001000 c=5 p=0 s=0",
    ]);
  });
});

describe("virtual time and the pattern engine", () => {
  it("runs steps on the virtual clock and drives the loopback", () => {
    const dev = rig();
    dev.execute("pattern add 0x1:5 0x2:5");
    dev.execute("pattern run once");
    expect(dev.inputs).toBe(0x1000);
    dev.advanceTo(1133); // end of step 0 = 5 * 200 + 133 ns
    expect(dev.inputs).toBe(0x2000);
    dev.advanceTo(2266);
    expect(dev.takeEvents()).toEqual(["! PATTERN_DONE loops=1"]);
    expect(dev.patternState).toBe("done");
  });

  it("refuses to run time backwards", () => {
    const dev = rig();
    dev.advanceTo(100);
    expect(() => dev.advanceTo(99)).toThrow(RangeError);
  });
});

describe("hooks and unsupported verbs", () => {
  it("markTsOverflow makes the next ts get report overflow once", () => {
    const dev = rig();
    dev.execute("ts arm 0x1000 both");
    dev.markTsOverflow();
    expect(dev.execute("ts get 1")[0]).toBe("OK count=0 overflow=1");
    expect(dev.execute("ts get 1")[0]).toBe("OK count=0 overflow=0");
  });

  it("resets drop sync state back to idle", () => {
    const dev = rig();
    expect(dev.execute("sync master")).toEqual(["OK"]);
    expect(dev.execute("reset")).toEqual(["OK"]);
    expect(dev.execute("sync start")).toEqual(["ERR SYNC_STATE"]);
  });

  it("syncEdge() starts a slave clock only once armed", () => {
    const dev = rig();
    dev.syncEdge();
    expect(dev.execute("sync count")).toEqual(["ERR SYNC_STATE"]);
    expect(dev.execute("sync arm")).toEqual(["OK"]);
    dev.advance(5_000);
    dev.syncEdge();
    expect(dev.execute("sync count")).toEqual(["OK clocks=0"]);
    dev.advance(3_000);
    expect(dev.execute("sync count")).toEqual(["OK clocks=3"]);
  });

  it("keeps flash state (saved map, device number) over reset and drops RAM state", () => {
    const dev = new MockDeviceCore();
    dev.execute("devnum 7");
    dev.execute("map set flags=0 dir=1 pu=0 pd=0xc7ffffe def=1 opol=0 ipol=0 edge=0xc7ffffe");
    dev.execute("reset");
    expect(dev.deviceNumber).toBe(7);
    expect(dev.currentMap).toEqual(PIN_MAP_DEFAULT);
    expect(dev.outputs).toBe(0);
  });
});

describe("safety model beyond the golden transcripts", () => {
  it("trips at the deadline inside one long advance, not at its end", () => {
    const dev = rig();
    dev.execute("wdog 100");
    dev.execute("write 0x1 0x1");
    dev.advance(5_000_000_000); // 5 s in one step
    expect(dev.takeEvents()).toEqual(["! FAILSAFE cause=wdog"]);
    expect(dev.outputs).toBe(0);
    // The event is pushed once, not once per elapsed timeout.
    dev.advance(5_000_000_000);
    expect(dev.takeEvents()).toEqual([]);
  });

  it("keeps the watchdog quiet while the host pings (heartbeat)", () => {
    const dev = rig();
    dev.execute("wdog 100");
    for (let i = 0; i < 40; i++) {
      dev.advance(25_000_000);
      expect(dev.execute("ping 1")).toEqual(["OK pong=1"]);
    }
    expect(dev.takeEvents()).toEqual([]);
    expect(dev.execute("safety")[0]).toContain("failsafe=0");
  });

  it("does not push a failsafe event while DTR is low, but latches", () => {
    const dev = rig();
    dev.execute("wdog 100");
    dev.setDtr(false);
    dev.advance(100_000_000);
    expect(dev.takeEvents()).toEqual([]);
    expect(dev.execute("safety")[0]).toContain("failsafe=1 cause=wdog");
  });

  it("drops the safety state and queued events on reboot", () => {
    const dev = rig();
    dev.execute("excl set 0x3");
    dev.execute("usbsafe on");
    dev.execute("wdog 100");
    dev.advance(100_000_000);
    dev.reboot("bor");
    expect(dev.takeEvents()).toEqual([]);
    expect(dev.execute("safety")).toEqual([
      "OK wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0",
    ]);
    expect(dev.execute("rstinfo")).toEqual(["OK cause=bor uptime_ms=0 boot=0x00000002"]);
  });

  it("reports an exclusive violation with the group and its mask", () => {
    const dev = rig();
    dev.execute("excl set 0x6");
    dev.execute("write 0x2 0x2");
    expect(dev.execute("write 0x4 0x4")).toEqual(["ERR EXCLUSIVE group=0 mask=0x00000006"]);
  });
});

describe("feature bits", () => {
  it("answers caps with the configured word and refuses commands whose bit is missing", () => {
    const dev = new MockDeviceCore({ features: 0x03 });
    expect(dev.execute("caps")[0]).toContain("feat=0x00000003");
    for (const line of ["wdog 0", "safety", "failsafe clear", "outputs reset", "excl get", "usbsafe on", "rstinfo", "pads"]) {
      expect(dev.execute(line), line).toEqual(["ERR UNKNOWN_CMD"]);
    }
    expect(dev.execute("ping 1")).toEqual(["OK pong=1"]);
  });

  it("offers a command with just its own bit", () => {
    const dev = new MockDeviceCore({ features: 0x08 });
    expect(dev.execute("excl get")).toEqual(["OK count=0"]);
    expect(dev.execute("wdog 0")).toEqual(["ERR UNKNOWN_CMD"]);
  });
});
