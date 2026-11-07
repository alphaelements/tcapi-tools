/**
 * Typed SDK errors (docs/sdk-api-design.md section 4). Every device error
 * name and SDK-level condition has a distinct, branchable code.
 */

export enum ErrorCode {
  // Device errors (from ERR responses)
  BadParam = "BAD_PARAM",
  BadMap = "BAD_MAP",
  Busy = "BUSY",
  Flash = "FLASH",
  TooLong = "TOO_LONG",
  NotArmed = "NOT_ARMED",
  SyncState = "SYNC_STATE",
  NoResource = "NO_RESOURCE",
  NotRunning = "NOT_RUNNING",
  UnknownCmd = "UNKNOWN_CMD",
  LineTooLong = "LINE_TOO_LONG",
  // Binary / HID transports only; a text device never answers these.
  BadCommand = "BAD_CMD",
  TransportNotSupported = "TRANSPORT_NOT_SUPPORTED",
  /** `ERR FAILSAFE`: the failsafe latch is set and the command would move an output away from `def`. */
  Failsafe = "FAILSAFE",
  /** `ERR EXCLUSIVE group=<i> mask=0x%08x`; the error is an `ExclusiveError` carrying both values. */
  Exclusive = "EXCLUSIVE",
  /** Any other `ERR <NAME>`; the raw name is kept in the message. */
  UnknownDevice = "UNKNOWN_DEVICE",

  // SDK errors
  Connection = "CONNECTION",
  Io = "IO",
  Parse = "PARSE",
  /** Rejected by host-side validation; nothing was sent. */
  InvalidArgument = "INVALID_ARGUMENT",
  Timeout = "TIMEOUT",
  NoDevice = "NO_DEVICE",
  MultipleDevices = "MULTIPLE_DEVICES",
  Disconnected = "DISCONNECTED",
  UnsupportedFirmware = "UNSUPPORTED_FIRMWARE",
  /** The read-back after `applySafety` differs from the applied settings. */
  SafetyMismatch = "SAFETY_MISMATCH",
}

/** Device `ERR <NAME>` -> (code, description). Anything else is UnknownDevice. */
const DEVICE_ERRORS: ReadonlyMap<string, readonly [ErrorCode, string]> = new Map([
  ["BAD_PARAM", [ErrorCode.BadParam, "invalid parameter"]],
  ["BAD_MAP", [ErrorCode.BadMap, "map validation failed"]],
  ["BUSY", [ErrorCode.Busy, "device is busy"]],
  ["FLASH", [ErrorCode.Flash, "flash write/read failed"]],
  ["TOO_LONG", [ErrorCode.TooLong, "payload too long"]],
  ["NOT_ARMED", [ErrorCode.NotArmed, "timestamp not armed"]],
  ["SYNC_STATE", [ErrorCode.SyncState, "invalid sync state transition"]],
  ["NO_RESOURCE", [ErrorCode.NoResource, "required resource not configured"]],
  ["NOT_RUNNING", [ErrorCode.NotRunning, "pattern not running"]],
  ["UNKNOWN_CMD", [ErrorCode.UnknownCmd, "unknown command"]],
  ["LINE_TOO_LONG", [ErrorCode.LineTooLong, "command line exceeds 256 bytes"]],
  ["BAD_CMD", [ErrorCode.BadCommand, "unknown binary command"]],
  [
    "TRANSPORT_NOT_SUPPORTED",
    [ErrorCode.TransportNotSupported, "command not supported on this transport"],
  ],
  ["FAILSAFE", [ErrorCode.Failsafe, "failsafe latch is set"]],
]);

const U8_MAX = 0xff;
const U32_MAX = 0xffffffff;

/** Decimal or `0x` hex digits only (no sign, no empty digit string) as a u32; else `undefined`. */
function parseU32HexOrDec(text: string): number | undefined {
  if (!/^0[xX][0-9a-fA-F]+$/.test(text) && !/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value <= U32_MAX ? value : undefined;
}

export class SdkError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "SdkError";
    this.code = code;
  }

  static parse(message: string): SdkError {
    return new SdkError(ErrorCode.Parse, `parse error: ${message}`);
  }

  static invalidArgument(message: string): SdkError {
    return new SdkError(ErrorCode.InvalidArgument, `invalid argument: ${message}`);
  }

  static timeout(): SdkError {
    return new SdkError(ErrorCode.Timeout, "timeout waiting for response");
  }

  static disconnected(detail?: string): SdkError {
    return new SdkError(
      ErrorCode.Disconnected,
      detail === undefined ? "device disconnected" : `device disconnected: ${detail}`,
    );
  }

  static unsupportedFirmware(detail: string): SdkError {
    return new SdkError(ErrorCode.UnsupportedFirmware, `unsupported firmware: ${detail}`);
  }

  /** The `safety` / `excl get` read-back differs from the applied settings. */
  static safetyMismatch(differences: string): SdkError {
    return new SdkError(
      ErrorCode.SafetyMismatch,
      `safety read-back differs from the applied settings: ${differences}`,
    );
  }

  /**
   * Map the text after `ERR ` to a typed error.
   *
   * The first whitespace-separated token is the error name; further tokens are
   * `key=value` data and never make the line unparseable (protocol-reference.md
   * section 3). `EXCLUSIVE` reads `group=` and `mask=` from them; an
   * `EXCLUSIVE` line without both is a protocol violation and becomes `Parse`.
   * For other known names the data tokens are ignored; an unknown name keeps
   * the whole text.
   */
  static fromErrorCode(text: string): SdkError {
    const [name = "", ...data] = text.split(/\s+/).filter((t) => t.length > 0);
    if (name === "EXCLUSIVE") return SdkError.exclusive(text, data);
    const entry = DEVICE_ERRORS.get(name);
    if (entry !== undefined) {
      return new SdkError(entry[0], `device error: ${name} (${entry[1]})`);
    }
    return new SdkError(ErrorCode.UnknownDevice, `device error: ${text}`);
  }

  private static exclusive(text: string, tokens: readonly string[]): SdkError {
    let group: number | undefined;
    let mask: number | undefined;
    for (const token of tokens) {
      const idx = token.indexOf("=");
      if (idx < 0) continue;
      const key = token.slice(0, idx);
      const value = token.slice(idx + 1);
      if (key === "group" && group === undefined) {
        const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
        group = Number.isSafeInteger(n) && n <= U8_MAX ? n : undefined;
      } else if (key === "mask" && mask === undefined) {
        mask = parseU32HexOrDec(value);
      }
    }
    if (group === undefined || mask === undefined) {
      return SdkError.parse(
        `malformed ERR EXCLUSIVE (expected group=<i> mask=0x%08x): ERR ${text}`,
      );
    }
    return new ExclusiveError(group, mask);
  }
}

/**
 * `ERR EXCLUSIVE`: an instruction would put two or more pins of an exclusive
 * group ON. `code` is `ErrorCode.Exclusive`.
 */
export class ExclusiveError extends SdkError {
  /** 0-based index of the first violating group. */
  readonly group: number;
  /** The pin mask of that group. */
  readonly mask: number;

  constructor(group: number, mask: number) {
    super(
      ErrorCode.Exclusive,
      `device error: EXCLUSIVE (exclusive group ${group} would be violated, mask 0x${mask.toString(16).padStart(8, "0")})`,
    );
    this.name = "ExclusiveError";
    this.group = group;
    this.mask = mask;
  }
}
