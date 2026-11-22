// Safety actions of the store against a scripted backend: the Tauri IPC layer
// is replaced by a command table and a recorder of the registered listeners.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEAT_EXCL, FEAT_OUTRESET, FEAT_USBSAFE, FEAT_WDOG, FEATURES_ALL } from "../lib/features";

type Handler = (args?: Record<string, unknown>) => unknown;
const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
let commands: Record<string, Handler> = {};
// Registered once (the store installs its listeners on the first startLoop).
const listeners = new Map<string, (payload: unknown) => void>();

vi.mock("../lib/tauri", () => ({
  tauriAvailable: true,
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    const h = commands[cmd];
    if (!h) throw `unexpected command ${cmd}`;
    return h(args);
  },
  listen: async (event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
    return () => {};
  },
}));

// The stream clock is not under test: its frame loop never ticks.
vi.stubGlobal("requestAnimationFrame", () => 0);

const { TcapiStore } = await import("./store");

const SAFE_OFF = {
  wdog_ms: 0,
  remaining_ms: 0,
  failsafe: false,
  cause: "none",
  usbsafe: false,
  excl: 0,
};

function caps(features: number) {
  return {
    dio: 25, out: 12, in: 13, ts_res_ns: 40, tick_ns: 200, pattern_max: 256, ring: 256, features,
  };
}

/// Backend that behaves like a healthy device with `features`.
function healthy(features: number, overrides: Record<string, Handler> = {}) {
  commands = {
    disconnect: () => null,
    connect: () => ({ uid: "u", device_number: 1, port: "/dev/x", version: "0.1.3" }),
    get_version: () => ({ major: 0, minor: 1, patch: 3, protocol_version: 2 }),
    get_caps: () => caps(features),
    map_get: () => ({
      flags: 0, direction: 0xfff, pull_up: 0, pull_down: 0x0c7ff000,
      out_default: 0, out_polarity: 0, in_polarity: 0, edge: 0x0c7ff000,
    }),
    subscribe: () => null,
    read_state: () => ({ inputs: 0, outputs: 0 }),
    get_safety: () => SAFE_OFF,
    excl_get: () => [],
    ...overrides,
  };
}

async function connect() {
  const store = TcapiStore;
  store.get().devices = [{ uid: "u", num: 1, port: "/dev/x", fw: "0.1.3" }];
  await store.connect("u");
  expect(store.get().connStatus).toBe("connected");
  store.startLoop();
  // installListeners runs from startLoop
  return store;
}

beforeEach(async () => {
  calls.length = 0;
  healthy(FEATURES_ALL);
  await TcapiStore.disconnect();
});

describe("connect reads the safety state per feature bit", () => {
  it("reads safety and excl on a device with the safety features", async () => {
    healthy(FEATURES_ALL, {
      get_safety: () => ({ ...SAFE_OFF, wdog_ms: 500 }),
      excl_get: () => [0x3, 0xc],
    });
    const S = (await connect()).get();
    expect(S.safety.state?.wdog_ms).toBe(500);
    expect(S.safety.groups).toEqual([0x3, 0xc]);
    // The watchdog is on, so the backend heartbeat is running.
    expect(S.safety.heartbeat).toBe("running");
  });

  it("sends no safety command to a device without the feature bits", async () => {
    healthy(0x03);
    const S = (await connect()).get();
    expect(calls.map((c) => c.cmd)).not.toContain("get_safety");
    expect(calls.map((c) => c.cmd)).not.toContain("excl_get");
    expect(S.safety.state).toBeNull();
    expect(TcapiStore.safetyFeatures().any).toBe(false);
  });

  it("asks only for what a partial device has", async () => {
    healthy(FEAT_EXCL | FEAT_OUTRESET);
    await connect();
    expect(calls.map((c) => c.cmd)).toContain("excl_get");
    expect(calls.map((c) => c.cmd)).not.toContain("get_safety");
  });
});

describe("push events", () => {
  it("shows the latch on tcapi://failsafe and stops the pattern state", async () => {
    healthy(FEATURES_ALL, {
      get_safety: () => ({ ...SAFE_OFF, wdog_ms: 100, failsafe: true, cause: "wdog" }),
    });
    const store = await connect();
    store.get().pattern.playState = "running";
    listeners.get("tcapi://failsafe")?.({ cause: "wdog" });
    expect(store.get().safety.state?.failsafe).toBe(true);
    expect(store.get().safety.state?.cause).toBe("wdog");
    expect(store.get().pattern.playState).toBe("idle");
    await vi.waitFor(() => expect(calls.filter((c) => c.cmd === "get_safety").length).toBeGreaterThan(1));
  });

  it("marks the heartbeat failed with the backend message", async () => {
    healthy(FEATURES_ALL, { get_safety: () => ({ ...SAFE_OFF, wdog_ms: 400 }) });
    const store = await connect();
    listeners.get("tcapi://heartbeat-failed")?.({ message: "ping: timeout waiting for response" });
    expect(store.get().safety.heartbeat).toBe("failed");
    expect(store.get().safety.heartbeatError).toBe("ping: timeout waiting for response");
    // A later refresh does not hide the failure while the watchdog is on.
    await store.refreshSafety();
    expect(store.get().safety.heartbeat).toBe("failed");
  });

  it("a new watchdog setting restarts the heartbeat status", async () => {
    healthy(FEATURES_ALL, {
      wdog: () => null,
      get_safety: () => ({ ...SAFE_OFF, wdog_ms: 400 }),
    });
    const store = await connect();
    listeners.get("tcapi://heartbeat-failed")?.({ message: "x" });
    await store.setWatchdog(400);
    expect(store.get().safety.heartbeat).toBe("running");
    expect(store.get().safety.heartbeatError).toBeNull();
    expect(calls.find((c) => c.cmd === "wdog")?.args).toEqual({ ms: 400 });
  });
});

describe("actions", () => {
  it("setWatchdog(0) turns the heartbeat off", async () => {
    healthy(FEATURES_ALL, { wdog: () => null });
    const store = await connect();
    await store.setWatchdog(0);
    expect(store.get().safety.heartbeat).toBe("off");
  });

  it("a rejected wdog is logged and leaves the heartbeat alone", async () => {
    healthy(FEATURES_ALL, {
      wdog: () => {
        throw "device error: BAD_PARAM (invalid parameter)";
      },
    });
    const store = await connect();
    await store.setWatchdog(99);
    expect(store.get().safety.heartbeat).toBe("off");
    expect(store.get().log.slice(-1)[0]?.text).toContain("wdog: device error: BAD_PARAM");
  });

  it("clearFailsafe calls failsafe_clear and re-reads the state", async () => {
    let latched = true;
    healthy(FEATURES_ALL, {
      failsafe_clear: () => {
        latched = false;
        return null;
      },
      get_safety: () => ({ ...SAFE_OFF, failsafe: latched, cause: latched ? "wdog" : "none" }),
    });
    const store = await connect();
    expect(store.get().safety.state?.failsafe).toBe(true);
    await store.clearFailsafe();
    expect(store.get().safety.state?.failsafe).toBe(false);
  });

  it("resetOutputs sends outputs_reset, stops the pattern state and re-reads the outputs", async () => {
    healthy(FEATURES_ALL, { outputs_reset: () => null });
    const store = await connect();
    store.get().pattern.playState = "running";
    calls.length = 0;
    await store.resetOutputs();
    expect(calls.map((c) => c.cmd)).toEqual(["outputs_reset", "read_state"]);
    expect(store.get().pattern.playState).toBe("idle");
  });

  it("a failing outputs_reset is logged and keeps the pattern state", async () => {
    healthy(FEATURES_ALL, {
      outputs_reset: () => {
        throw "device disconnected";
      },
    });
    const store = await connect();
    store.get().pattern.playState = "running";
    await store.resetOutputs();
    expect(store.get().pattern.playState).toBe("running");
    store.get().pattern.playState = "idle";
  });

  it("setExclusiveGroups sends excl_set, or excl_clear for none", async () => {
    healthy(FEATURES_ALL, { excl_set: () => null, excl_clear: () => null });
    const store = await connect();
    await store.setExclusiveGroups([0x3, 0xc]);
    expect(calls.find((c) => c.cmd === "excl_set")?.args).toEqual({ masks: [0x3, 0xc] });
    await store.setExclusiveGroups([]);
    expect(calls.map((c) => c.cmd)).toContain("excl_clear");
  });

  it("setUsbsafe passes the flag", async () => {
    healthy(FEAT_WDOG | FEAT_USBSAFE, { usbsafe: () => null });
    const store = await connect();
    await store.setUsbsafe(true);
    expect(calls.find((c) => c.cmd === "usbsafe")?.args).toEqual({ on: true });
  });
});

describe("applySafetyFile", () => {
  it("loads the file in the backend, applies it and shows the result", async () => {
    const config = { watchdog_ms: 1000, usbsafe: true, groups: [0x3] };
    healthy(FEATURES_ALL, {
      safety_load_toml: () => config,
      apply_safety: () => ({ ...SAFE_OFF, wdog_ms: 1000, usbsafe: true, excl: 1 }),
      get_safety: () => ({ ...SAFE_OFF, wdog_ms: 1000, usbsafe: true, excl: 1 }),
    });
    const store = await connect();
    await store.applySafetyFile("/tmp/safety.toml");
    const S = store.get().safety;
    expect(calls.find((c) => c.cmd === "safety_load_toml")?.args).toEqual({ path: "/tmp/safety.toml" });
    expect(calls.find((c) => c.cmd === "apply_safety")?.args).toEqual({ config });
    expect(S.applied).toEqual(config);
    expect(S.fileError).toBeNull();
    expect(S.heartbeat).toBe("running");
  });

  it("keeps the file:line: message error of a bad file and never applies it", async () => {
    healthy(FEATURES_ALL, {
      safety_load_toml: () => {
        throw "parse error: /tmp/safety.toml:4: watchdog.timeout_ms must be 0 or 100-10000";
      },
    });
    const store = await connect();
    await store.applySafetyFile("/tmp/safety.toml");
    expect(store.get().safety.fileError).toBe(
      "parse error: /tmp/safety.toml:4: watchdog.timeout_ms must be 0 or 100-10000",
    );
    expect(calls.map((c) => c.cmd)).not.toContain("apply_safety");
    store.dismissFileError();
    expect(store.get().safety.fileError).toBeNull();
  });

  it("reports a failed apply as the file error too", async () => {
    healthy(FEATURES_ALL, {
      safety_load_toml: () => ({ watchdog_ms: 0, usbsafe: false, groups: [0x30000] }),
      apply_safety: () => {
        throw "device error: BAD_PARAM (invalid parameter)";
      },
    });
    const store = await connect();
    await store.applySafetyFile("/tmp/safety.toml");
    expect(store.get().safety.fileError).toContain("BAD_PARAM");
    expect(store.get().safety.applied).toBeNull();
  });
});

describe("exclusive violation", () => {
  it("is kept when a write is refused, then dismissed", async () => {
    healthy(FEATURES_ALL, {
      write_outputs: () => {
        throw "device error: EXCLUSIVE (exclusive group 1 would be violated, mask 0x0000000c)";
      },
    });
    const store = await connect();
    await store.writeHex(0xc);
    expect(store.get().safety.violation).toEqual({ group: 1, mask: 0xc });
    store.dismissViolation();
    expect(store.get().safety.violation).toBeNull();
  });

  it("an unrelated error does not set a violation", async () => {
    healthy(FEATURES_ALL, {
      write_outputs: () => {
        throw "device error: BUSY (device is busy)";
      },
    });
    const store = await connect();
    await store.writeHex(0x1);
    expect(store.get().safety.violation).toBeNull();
  });

  it("a write refused by the latch re-reads the safety state", async () => {
    healthy(FEATURES_ALL, {
      write_outputs: () => {
        throw "device error: FAILSAFE (failsafe latch is set)";
      },
      get_safety: () => ({ ...SAFE_OFF, failsafe: true, cause: "usb" }),
    });
    const store = await connect();
    store.get().safety.state = null;
    await store.writeHex(0x1);
    await vi.waitFor(() => expect(store.get().safety.state?.failsafe).toBe(true));
  });
});

describe("disconnect", () => {
  it("drops the safety state", async () => {
    healthy(FEATURES_ALL, { get_safety: () => ({ ...SAFE_OFF, wdog_ms: 300 }) });
    const store = await connect();
    await store.disconnect();
    expect(store.get().safety.state).toBeNull();
    expect(store.get().safety.heartbeat).toBe("off");
  });
});
