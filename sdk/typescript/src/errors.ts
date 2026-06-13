/**
 * Typed SDK errors. Mirrors `sdk/rust/src/error.rs`; every device error
 * code and SDK-level condition has a distinct, branchable code.
 */

export enum ErrorCode {
  // Device errors (from ERR responses)
  BadCommand = "BAD_CMD",
  BadParam = "BAD_PARAM",
  BadMap = "BAD_MAP",
  Busy = "BUSY",
  Flash = "FLASH",
  TooLong = "TOO_LONG",
  NotArmed = "NOT_ARMED",
  SyncState = "SYNC_STATE",
  SyncTimeout = "SYNC_TIMEOUT",
  NoResource = "NO_RESOURCE",
  NotRunning = "NOT_RUNNING",
  UnknownDevice = "UNKNOWN_DEVICE",

  // SDK errors
  Connection = "CONNECTION",
  Io = "IO",
  Parse = "PARSE",
  Timeout = "TIMEOUT",
  NoDevice = "NO_DEVICE",
  MultipleDevices = "MULTIPLE_DEVICES",
  Disconnected = "DISCONNECTED",
  UnsupportedFirmware = "UNSUPPORTED_FIRMWARE",
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

  static timeout(): SdkError {
    return new SdkError(ErrorCode.Timeout, "timeout waiting for response");
  }

  static disconnected(): SdkError {
    return new SdkError(ErrorCode.Disconnected, "device disconnected");
  }

  static unsupportedFirmware(detail: string): SdkError {
    return new SdkError(
      ErrorCode.UnsupportedFirmware,
      `unsupported firmware: ${detail} (requires FW Phase 9.6+)`,
    );
  }

  /** Map an `ERR <code>` response to a typed error. */
  static fromErrorCode(code: string): SdkError {
    const map: Record<string, [ErrorCode, string]> = {
      BAD_CMD: [ErrorCode.BadCommand, "unknown command"],
      UNKNOWN_CMD: [ErrorCode.BadCommand, "unknown text command"],
      BAD_PARAM: [ErrorCode.BadParam, "invalid parameter"],
      BAD_MAP: [ErrorCode.BadMap, "map validation failed"],
      BUSY: [ErrorCode.Busy, "device is busy"],
      FLASH: [ErrorCode.Flash, "flash write/read failed"],
      TOO_LONG: [ErrorCode.TooLong, "payload too long"],
      LINE_TOO_LONG: [ErrorCode.TooLong, "command line exceeds 128 bytes"],
      NOT_ARMED: [ErrorCode.NotArmed, "timestamp not armed"],
      SYNC_STATE: [ErrorCode.SyncState, "invalid sync state transition"],
      SYNC_TIMEOUT: [ErrorCode.SyncTimeout, "sync pulse not detected"],
      NO_RESOURCE: [ErrorCode.NoResource, "required resource not configured"],
      NOT_RUNNING: [ErrorCode.NotRunning, "pattern not running"],
    };
    const entry = map[code];
    if (entry) {
      return new SdkError(entry[0], `device error: ${code} (${entry[1]})`);
    }
    return new SdkError(ErrorCode.UnknownDevice, `device error: ${code}`);
  }
}
