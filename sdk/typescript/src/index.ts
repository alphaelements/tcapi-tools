/**
 * TypeScript SDK for Pochi-DIO — RP2350-based high-speed digital I/O unit.
 *
 * Talks the USB CDC text command mode (`{cmd}\r\n` → `OK ...` /
 * `ERR ...`, push lines `! ...`). Requires firmware Phase 9.6+; older
 * firmware is rejected explicitly (never parsed silently).
 *
 * The Rust SDK (`sdk/rust`) is the reference implementation; this SDK
 * mirrors its behavior and JSON wire format exactly.
 */

export const VERSION = "0.1.0";

export { Connection, type ConnectionEvents } from "./connection.js";
export {
  discover,
  discoverDetailed,
  enumeratePorts,
  findByDeviceNumber,
  findByUid,
  findDuplicateNumbers,
  matchesPochi,
  probe,
  selectSoleDevice,
  type Discovery,
  type ProbeFailure,
  type UsbPortInfo,
} from "./discovery.js";
export { ErrorCode, SdkError } from "./errors.js";
export { fromWire, toWire, toWireJson } from "./json.js";
export * as protocol from "./protocol.js";
export * as reconcile from "./reconcile.js";
export {
  BAUD_RATE,
  DEFAULT_COMMAND_TIMEOUT_MS,
  Transport,
  type PortLike,
} from "./transport.js";
export {
  hasSync,
  type Capabilities,
  type DeviceInfo,
  type EdgeMode,
  type IoState,
  type PatternMode,
  type PatternState,
  type PatternStatus,
  type PatternStep,
  type PinMap,
  type PullMode,
  type PushEvent,
  type SyncRole,
  type SyncState,
  type TimestampEvent,
  type TimestampResult,
  type VersionInfo,
} from "./types.js";
