/**
 * TypeScript SDK for Pochi-DIO — RP2350-based high-speed digital I/O unit.
 *
 * Talks the USB CDC text command mode of protocol v2 (`{cmd}\r\n` ->
 * `OK ...` / `ERR ...`, push lines `! ...`). Opening a connection asserts DTR
 * and requires `version` to report `proto=2`; any other protocol is rejected
 * (UnsupportedFirmware), never parsed leniently.
 *
 * The Rust SDK (`sdk/rust`) is the reference implementation; this SDK
 * mirrors its behavior and JSON wire format. Every bit mask is a physical GP
 * bit position; use `chToGp` / `gpToCh` / `pinLabel` for logical channels.
 */

export const VERSION = "0.1.0";

export { Connection, type ConnectionEvents, type Unsubscribe } from "./connection.js";
export {
  discover,
  discoverDetailed,
  enumeratePorts,
  findByDeviceNumber,
  findByUid,
  findDuplicateNumbers,
  matchesPochi,
  probe,
  probeTransport,
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
  DIO_CHANNELS,
  FEAT_RESET,
  FEAT_SYNC,
  PATTERN_TICK_NS,
  PROTO_VERSION,
  VALID_DIO_MASK,
  chToGp,
  checkDioMask,
  defaultPinMap,
  gpToCh,
  hasReset,
  hasSync,
  holdTicksFromNs,
  patternStepHoldNs,
  patternStepToText,
  pinLabel,
  pinMapToSetArgs,
  timestampNs,
  validatePatternStep,
  validatePinMap,
  type Capabilities,
  type DeviceInfo,
  type EdgeMode,
  type IoState,
  type PatternMode,
  type PatternState,
  type PatternStatus,
  type PatternStep,
  type PinMap,
  type PushEvent,
  type SyncRole,
  type SyncState,
  type TimestampEvent,
  type TimestampResult,
  type TsStatus,
  type VersionInfo,
} from "./types.js";
