/** Discovery: USB filter, v2 probe, selection helpers. */
import { describe, expect, it } from "vitest";
import {
  findByDeviceNumber,
  findByUid,
  findDuplicateNumbers,
  matchesTcapi,
  probeTransport,
  selectSoleDevice,
} from "../src/discovery.js";
import { ErrorCode, SdkError } from "../src/errors.js";
import { Transport } from "../src/transport.js";
import type { DeviceInfo } from "../src/types.js";
import { FakePort } from "./helpers/fake-port.js";
import { GoldenPort, goldenRequest, handshakeItems } from "./helpers/golden.js";

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

describe("matchesTcapi", () => {
  const base = { path: "/dev/ttyACM0", vendorId: "2E8A", productId: "1175" };

  it("accepts a Tcapi product on VID 2E8A / PID 1175 (case-insensitive ids)", () => {
    expect(matchesTcapi({ ...base, pnpId: "usb-Raspberry_Pi_Tcapi-DIO_0123-if00" })).toBe(true);
    expect(matchesTcapi({ ...base, vendorId: "2e8a", productId: "1175", pnpId: "usb-Tcapi" })).toBe(true);
  });

  it("rejects the legacy Tachyon name", () => {
    expect(matchesTcapi({ ...base, pnpId: "usb-Raspberry_Pi_Tachyon-DIO_0123-if00" })).toBe(false);
  });

  it("rejects a Debugprobe (PID 000c), other vendors and a missing product string", () => {
    expect(matchesTcapi({ ...base, productId: "000c", pnpId: "usb-Tcapi" })).toBe(false);
    expect(matchesTcapi({ ...base, vendorId: "1234", pnpId: "usb-Tcapi" })).toBe(false);
    expect(matchesTcapi(base)).toBe(false);
  });
});

describe("probeTransport", () => {
  async function transportFor(items: ConstructorParameters<typeof GoldenPort>[0]) {
    const port = new GoldenPort(items);
    const transport = await Transport.attach(port);
    port.start();
    return { transport, port };
  }

  it("reports uid, device number, version and port for a proto=2 device", async () => {
    const info = goldenRequest("version-info", "info: factory state has no device number (255 = unassigned)", "info");
    const { transport, port } = await transportFor([...handshakeItems(), info]);
    await expect(probeTransport(transport, "/dev/ttyACM0")).resolves.toEqual({
      uid: "0000000000000000",
      deviceNumber: null,
      port: "/dev/ttyACM0",
      version: "0.1.3",
    });
    expect(port.remainingRequests()).toBe(0);
  });

  it("negative: a device that is not on proto=2 fails with UnsupportedFirmware and is not asked for info", async () => {
    const port = new FakePort();
    port.onCommand = () => port.feed("OK fw=0.1.0 proto=1");
    const transport = await Transport.attach(port);
    await expectCode(probeTransport(transport, "/dev/ttyACM0"), ErrorCode.UnsupportedFirmware);
    expect(port.written).toEqual(["version"]);
  });

  it("negative: a silent port times out", async () => {
    const port = new FakePort();
    const transport = await Transport.attach(port);
    transport.timeoutMs = 50;
    await expectCode(probeTransport(transport, "/dev/ttyACM0"), ErrorCode.Timeout);
  });
});

describe("selection helpers", () => {
  const dev = (uid: string, deviceNumber: number | null, port: string): DeviceInfo => ({
    uid,
    deviceNumber,
    port,
    version: "0.1.3",
  });
  const a = dev("AABBCCDD11223344", 1, "/dev/ttyACM0");
  const b = dev("0000000000000001", 1, "/dev/ttyACM1");
  const c = dev("0000000000000002", null, "/dev/ttyACM2");

  it("findByUid is case-insensitive", () => {
    expect(findByUid([a, b], "aabbccdd11223344")).toBe(a);
    expect(() => findByUid([a], "FF")).toThrow(/no Tcapi-DIO device with UID/);
  });

  it("findByDeviceNumber reports duplicates as MultipleDevices", () => {
    expect(findByDeviceNumber([a, c], 1)).toBe(a);
    expect(() => findByDeviceNumber([a, b], 1)).toThrow(/multiple devices/);
    expect(() => findByDeviceNumber([a], 9)).toThrow(/no Tcapi-DIO device/);
  });

  it("selectSoleDevice", () => {
    expect(selectSoleDevice([c])).toBe(c);
    expect(() => selectSoleDevice([])).toThrow(/no Tcapi-DIO device found/);
    expect(() => selectSoleDevice([a, b])).toThrow(/2 Tcapi-DIO devices/);
  });

  it("findDuplicateNumbers ignores unassigned devices", () => {
    expect(findDuplicateNumbers([a, b, c, c])).toEqual([1]);
  });
});
