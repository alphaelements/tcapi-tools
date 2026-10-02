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
}

/** Device `ERR <NAME>` -> (code, description). Anything else is UnknownDevice. */
const DEVICE_ERRORS: Record<string, [ErrorCode, string]> = {
  BAD_PARAM: [ErrorCode.BadParam, "invalid parameter"],
  BAD_MAP: [ErrorCode.BadMap, "map validation failed"],
  BUSY: [ErrorCode.Busy, "device is busy"],
  FLASH: [ErrorCode.Flash, "flash write/read failed"],
  TOO_LONG: [ErrorCode.TooLong, "payload too long"],
  NOT_ARMED: [ErrorCode.NotArmed, "timestamp not armed"],
  SYNC_STATE: [ErrorCode.SyncState, "invalid sync state transition"],
  NO_RESOURCE: [ErrorCode.NoResource, "required resource not configured"],
  NOT_RUNNING: [ErrorCode.NotRunning, "pattern not running"],
  UNKNOWN_CMD: [ErrorCode.UnknownCmd, "unknown command"],
  LINE_TOO_LONG: [ErrorCode.LineTooLong, "command line exceeds 256 bytes"],
  BAD_CMD: [ErrorCode.BadCommand, "unknown binary command"],
  TRANSPORT_NOT_SUPPORTED: [
    ErrorCode.TransportNotSupported,
    "command not supported on this transport",
  ],
};

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

  /** Map an `ERR <name>` response to a typed error. */
  static fromErrorCode(name: string): SdkError {
    const entry = DEVICE_ERRORS[name];
    if (entry) {
      return new SdkError(entry[0], `device error: ${name} (${entry[1]})`);
    }
    return new SdkError(ErrorCode.UnknownDevice, `device error: ${name}`);
  }
}
