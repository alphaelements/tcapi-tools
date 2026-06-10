#!/usr/bin/env node
/**
 * Hardware smoke test — requires a connected Pochi-DIO device.
 * Run after `npm run build`:  node scripts/hw-smoke.mjs
 * Mirrors `sdk/rust/tests/hw_smoke.rs`; restores device state on exit.
 */
import {
  Connection,
  discoverDetailed,
  hasSync,
} from "../dist/index.js";

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const detailed = await discoverDetailed();
assert(detailed.failures.length === 0, `probe failures: ${JSON.stringify(detailed.failures)}`);
const devices = detailed.devices;
assert(devices.length > 0, "no Pochi-DIO found");
console.log("discovered:", devices);
assert(
  devices.every((d) => !d.port.includes("ttyACM2")),
  "Debugprobe misdetected as Pochi-DIO",
);

const device = devices[0];
const conn = await Connection.open(device.port);
try {
  const version = await conn.version();
  console.log("version:", version);
  const caps = await conn.caps();
  console.log("caps:", caps, "hasSync:", hasSync(caps));
  assert(caps.maxDio === 23, "maxDio");
  assert(caps.tsResolutionNs !== 1000, "old firmware");
  const info = await conn.info();
  assert(info.uid === device.uid, "uid mismatch");

  const originalMap = await conn.mapGet();
  console.log("original map:", originalMap);

  // pin map 12 out / 11 in
  await conn.mapSet({
    version: 1,
    outBase: 0,
    outCount: 12,
    inBase: 12,
    inCount: 11,
    pull: "up",
    flags: 0x01,
  });
  const active = await conn.mapGet();
  assert(active.outCount === 12 && active.inCount === 11, "map set");

  // write / read / state
  await conn.write(0x0a5, 0xfff);
  const state = await conn.state();
  console.log("state after write 0x0A5:", state);
  assert((state.outputs & 0xfff) === 0x0a5, "outputs");
  await conn.write(0, 0xfff);

  // pattern once + loop (repeat=0 is BAD_PARAM on FW)
  const accepted = await conn.patternLoad([
    { outBits: 0x00f, holdUs: 1000 },
    { outBits: 0x000, holdUs: 1000 },
    { outBits: 0x0f0, holdUs: 1000 },
    { outBits: 0x000, holdUs: 1000 },
  ]);
  assert(accepted === 4, "accepted");
  await conn.patternRun("once", 1);
  await new Promise((r) => setTimeout(r, 50));
  const afterOnce = await conn.patternStatus();
  console.log("pattern status after once:", afterOnce);
  assert(afterOnce.state !== "running", "still running");
  await conn.patternRun("loop", 1000);
  await new Promise((r) => setTimeout(r, 20));
  assert((await conn.patternStatus()).state === "running", "loop not running");
  await conn.patternStop();
  assert((await conn.patternStatus()).state !== "running", "stop failed");

  // ts arm/get/disarm (count=0 counted read path)
  await conn.tsArm(0x07ff, "both");
  const result = await conn.tsGet(256);
  console.log(`ts events without stimulus: ${result.events.length}`);
  await conn.tsDisarm();
  await conn.read(); // connection healthy after counted read

  // subscribe on/off
  await conn.subscribe(true);
  await conn.subscribe(false);

  // sync single device
  await conn.syncMaster();
  await conn.syncStart();
  const c1 = await conn.syncCount();
  await new Promise((r) => setTimeout(r, 10));
  const c2 = await conn.syncCount();
  console.log(`sync counts: ${c1} -> ${c2}`);
  assert(c2 > c1, "sync clock not advancing");
  await conn.syncStop();
  await conn.syncDisarm();

  // raw escape hatch
  const raw = await conn.raw("version");
  assert(raw.startsWith("OK "), `raw: ${raw}`);

  // restore original map and persist
  await conn.mapSet(originalMap);
  await conn.mapSave();
  const restored = await conn.mapGet();
  assert(restored.outCount === originalMap.outCount, "map restore");

  console.log("hw-smoke: all steps passed");
} finally {
  await conn.close();
}
