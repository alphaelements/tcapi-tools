#!/usr/bin/env node
/**
 * Hardware smoke test (protocol v2) — requires a connected Tcapi-DIO device.
 * Run after `npm run build`:  node scripts/hw-smoke.mjs
 * Mirrors `sdk/rust/tests/hw_smoke.rs`; restores device state on exit.
 */
import { SerialPort } from "serialport";
import {
  Connection,
  PROTO_VERSION,
  chToGp,
  discoverDetailed,
  hasSync,
  timestampNs,
} from "../dist/index.js";

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const detailed = await discoverDetailed();
assert(detailed.failures.length === 0, `probe failures: ${JSON.stringify(detailed.failures)}`);
const devices = detailed.devices;
assert(devices.length > 0, "no Tcapi-DIO found");
console.log("discovered:", devices);

// A Debugprobe (2e8a:000c) on the same host must NOT be detected. Its tty
// number depends on plug order, so locate it by USB descriptor instead of
// hard-coding a port name.
const debugprobePorts = (await SerialPort.list())
  .filter(
    (p) =>
      p.vendorId?.toLowerCase() === "2e8a" &&
      p.productId?.toLowerCase() === "000c",
  )
  .map((p) => p.path);
console.log("debugprobe ports:", debugprobePorts);
assert(
  devices.every((d) => !debugprobePorts.includes(d.port)),
  "Debugprobe misdetected as Tcapi-DIO",
);

const device = devices[0];
const conn = await Connection.open(device.port);
try {
  const version = await conn.version();
  console.log("version:", version);
  assert(version.protocolVersion === PROTO_VERSION, "protocol version");
  const caps = await conn.caps();
  console.log("caps:", caps, "hasSync:", hasSync(caps));
  assert(caps.dio === 25, "dio");
  assert(caps.tsResNs === 40 && caps.tickNs === 200, "resolutions");
  const info = await conn.info();
  assert(info.uid === device.uid, "uid mismatch");

  const originalMap = await conn.mapGet();
  console.log("original map:", originalMap);

  // GP0-GP3 outputs (ch0-ch3), everything else input with pull-down
  const outputs = 0x0f;
  await conn.mapSet({
    flags: 0,
    direction: outputs,
    pullUp: 0,
    pullDown: 0x0c7fffff & ~outputs,
    outDefault: 0,
    outPolarity: 0,
    inPolarity: 0,
    edge: 0x0c7fffff & ~outputs,
  });
  const active = await conn.mapGet();
  assert(active.direction === outputs, "map set");

  // write / read / state
  await conn.write(0x05, outputs);
  const state = await conn.state();
  console.log("state after write 0x5:", state);
  assert((state.outputs & outputs) === 0x05, "outputs");
  await conn.write(0, outputs);
  assert(chToGp(23) === 26, "pin helper");

  // pattern once + loop (steps are appended; patternLoad resets first)
  const total = await conn.patternLoad([
    { outBits: 0x1, holdTicks: 5000 },
    { outBits: 0x0, holdTicks: 5000 },
    { outBits: 0x2, holdTicks: 5000 },
    { outBits: 0x0, holdTicks: 5000 },
  ]);
  assert(total === 4, "pattern total");
  await conn.patternRun("once");
  await new Promise((r) => setTimeout(r, 50));
  const afterOnce = await conn.patternStatus();
  console.log("pattern status after once:", afterOnce);
  assert(afterOnce.state !== "running", "still running");
  await conn.patternRun("loop", 1000);
  await new Promise((r) => setTimeout(r, 20));
  assert((await conn.patternStatus()).state === "running", "loop not running");
  await conn.patternStop();
  assert((await conn.patternStatus()).state !== "running", "stop failed");
  await conn.patternReset();

  // ts arm/get/disarm (count=0 counted read path)
  await conn.tsArm(0x07f0, "both");
  const result = await conn.tsGet(85);
  console.log(
    `ts events without stimulus: ${result.events.length}`,
    result.events.map((e) => timestampNs(e, caps.tsResNs)),
  );
  await conn.tsDisarm();
  await conn.read(); // connection healthy after counted read

  // subscription is owned by the SDK
  const stop = await conn.subscribeEvents(() => undefined);
  await stop();

  // sync single device
  if (hasSync(caps)) {
    await conn.syncMaster();
    await conn.syncStart();
    const c1 = await conn.syncCount();
    await new Promise((r) => setTimeout(r, 10));
    const c2 = await conn.syncCount();
    console.log(`sync counts: ${c1} -> ${c2}`);
    assert(c2 > c1, "sync clock not advancing");
    await conn.syncStop();
    await conn.syncDisarm();
  }

  // raw escape hatch returns every line
  const raw = await conn.raw("version");
  assert(raw.length === 1 && raw[0].startsWith("OK "), `raw: ${raw}`);

  // restore original map and persist
  await conn.mapSet(originalMap);
  await conn.mapSave();
  const restored = await conn.mapGet();
  assert(restored.direction === originalMap.direction, "map restore");

  console.log("hw-smoke: all steps passed");
} finally {
  await conn.close();
}
