/**
 * Device discovery: USB enumeration, probing, and selection.
 * Mirrors `sdk/rust/src/discovery.rs`. A port is probed with DTR asserted and
 * `version`; a device that does not report `proto=2` is not usable.
 */

import { SerialPort } from "serialport";
import { ErrorCode, SdkError } from "./errors.js";
import { assertSupportedProtocol, parseInfo, parseVersion } from "./protocol.js";
import { Transport } from "./transport.js";
import type { DeviceInfo } from "./types.js";

const POCHI_VID = "2e8a";
const POCHI_PID = "000a";

/** A port that matched the USB filter but could not be probed. */
export interface ProbeFailure {
  port: string;
  error: SdkError;
}

/** Full discovery outcome, including ports that failed to respond. */
export interface Discovery {
  devices: DeviceInfo[];
  /** Matching ports that could not be opened or probed (e.g. held open
   *  by another process). Not fatal for the scan as a whole. */
  failures: ProbeFailure[];
}

/** Subset of serialport's PortInfo the filter needs. */
export interface UsbPortInfo {
  path: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
}

/**
 * True if the USB descriptor identifies a Pochi-DIO. node-serialport
 * exposes no product string on Linux, so the product check uses pnpId
 * (e.g. `usb-Raspberry_Pi_Pochi-DIO_<uid>-if00`).
 */
export function matchesPochi(info: UsbPortInfo): boolean {
  if (info.vendorId?.toLowerCase() !== POCHI_VID) return false;
  if (info.productId?.toLowerCase() !== POCHI_PID) return false;
  const pnp = info.pnpId ?? "";
  return pnp.includes("Pochi");
}

/**
 * List serial port paths whose USB descriptors match a Pochi-DIO
 * (VID 0x2E8A / PID 0x000A / product "Pochi*").
 * No ports are opened. Results are sorted by port path: the OS
 * enumeration order is unspecified, and callers rely on a deterministic
 * device order.
 */
export async function enumeratePorts(): Promise<string[]> {
  const ports = await SerialPort.list();
  return ports
    .filter((p) => matchesPochi(p))
    .map((p) => p.path)
    .sort();
}

/** Probe one port: open it (DTR asserted), require `proto=2`, then query `info`. */
export async function probe(portPath: string): Promise<DeviceInfo> {
  const transport = await Transport.open(portPath);
  try {
    return await probeTransport(transport, portPath);
  } finally {
    await transport.close();
  }
}

/**
 * Probe over an already-open transport: `version` must report `proto=2`
 * (UnsupportedFirmware otherwise, `info` is not sent), then `info` supplies the
 * UID and device number. A device on another protocol version is a failure of
 * the scan, not a usable device.
 */
export async function probeTransport(
  transport: Transport,
  portPath: string,
): Promise<DeviceInfo> {
  const version = parseVersion(await transport.command("version"));
  assertSupportedProtocol(version);
  const { uid, deviceNumber } = parseInfo(await transport.command("info"));
  return {
    uid,
    deviceNumber,
    port: portPath,
    version: `${version.major}.${version.minor}.${version.patch}`,
  };
}

/**
 * Enumerate and probe all connected Pochi-DIO devices, reporting probe
 * failures alongside successes.
 */
export async function discoverDetailed(): Promise<Discovery> {
  const result: Discovery = { devices: [], failures: [] };
  for (const port of await enumeratePorts()) {
    try {
      result.devices.push(await probe(port));
    } catch (err) {
      const error =
        err instanceof SdkError
          ? err
          : new SdkError(ErrorCode.Connection, String(err));
      result.failures.push({ port, error });
    }
  }
  return result;
}

/**
 * Enumerate and probe all connected Pochi-DIO devices. Convenience
 * wrapper over `discoverDetailed` that returns devices only.
 */
export async function discover(): Promise<DeviceInfo[]> {
  return (await discoverDetailed()).devices;
}

/** Find the device with the given UID (case-insensitive). */
export function findByUid(devices: DeviceInfo[], uid: string): DeviceInfo {
  const upper = uid.toUpperCase();
  const device = devices.find((d) => d.uid.toUpperCase() === upper);
  if (!device) {
    throw new SdkError(ErrorCode.NoDevice, `no Pochi-DIO device with UID ${uid}`);
  }
  return device;
}

/**
 * Find the device with the given device number. Duplicate numbers are a
 * user-configuration conflict and reported as MultipleDevices.
 */
export function findByDeviceNumber(devices: DeviceInfo[], n: number): DeviceInfo {
  const matches = devices.filter((d) => d.deviceNumber === n);
  if (matches.length === 0) {
    throw new SdkError(ErrorCode.NoDevice, `no Pochi-DIO device with device number ${n}`);
  }
  if (matches.length > 1) {
    throw new SdkError(
      ErrorCode.MultipleDevices,
      `multiple devices with device number ${n}; use UID or port to disambiguate`,
    );
  }
  return matches[0];
}

/** Select the only device, erroring when there are zero or several. */
export function selectSoleDevice(devices: DeviceInfo[]): DeviceInfo {
  if (devices.length === 0) {
    throw new SdkError(ErrorCode.NoDevice, "no Pochi-DIO device found");
  }
  if (devices.length > 1) {
    throw new SdkError(
      ErrorCode.MultipleDevices,
      `${devices.length} Pochi-DIO devices found; specify UID, device number, or port`,
    );
  }
  return devices[0];
}

/** Device numbers assigned to more than one device. */
export function findDuplicateNumbers(devices: DeviceInfo[]): number[] {
  const seen = new Map<number, number>();
  const duplicates: number[] = [];
  for (const dev of devices) {
    if (dev.deviceNumber === null) continue;
    const count = (seen.get(dev.deviceNumber) ?? 0) + 1;
    seen.set(dev.deviceNumber, count);
    if (count === 2) duplicates.push(dev.deviceNumber);
  }
  return duplicates;
}
