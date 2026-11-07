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
 *
 * Safety functions: `Connection.wdog / safety / failsafeClear / outputsReset /
 * exclSet / exclClear / exclGet / usbsafe / rstinfo / pads`, the watchdog
 * heartbeat (`Connection.startHeartbeat`), `parseSafety` / `loadSafety` for
 * `safety.toml` and `Connection.applySafety` to make the device equal to it.
 */

export const VERSION = "0.1.0";

export { ConfigError, loadSafety, parseSafety } from "./config.js";
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
export { ErrorCode, ExclusiveError, SdkError } from "./errors.js";
export { Heartbeat, heartbeatPeriodMs, type HeartbeatEvents } from "./heartbeat.js";
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
  FEATURE_ALL,
  FEATURE_MASK,
  FEAT_EXCL,
  FEAT_OUTRESET,
  FEAT_PADS,
  FEAT_RESET,
  FEAT_RSTINFO,
  FEAT_SYNC,
  FEAT_USBSAFE,
  FEAT_WDOG,
  Feature,
  MAX_EXCLUSIVE_GROUPS,
  PATTERN_TICK_NS,
  PROTO_VERSION,
  VALID_DIO_MASK,
  WDOG_MAX_MS,
  WDOG_MIN_MS,
  chToGp,
  checkDioMask,
  defaultPinMap,
  defaultSafetyConfig,
  failsafeCauseFromName,
  featureBit,
  featureList,
  gpToCh,
  hasFeature,
  hasReset,
  hasSync,
  holdTicksFromNs,
  patternStepHoldNs,
  patternStepToText,
  pinLabel,
  pinMapToSetArgs,
  resetCauseFromName,
  timestampNs,
  validatePatternStep,
  validatePinMap,
  type Capabilities,
  type DeviceInfo,
  type EdgeMode,
  type FailsafeCause,
  type IoState,
  type Pads,
  type PatternMode,
  type PatternState,
  type PatternStatus,
  type PatternStep,
  type PinMap,
  type PushEvent,
  type ResetCause,
  type ResetInfo,
  type SafetyConfig,
  type SafetyState,
  type SyncRole,
  type SyncState,
  type TimestampEvent,
  type TimestampResult,
  type TsStatus,
  type VersionInfo,
} from "./types.js";
