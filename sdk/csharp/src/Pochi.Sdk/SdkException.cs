namespace Pochi.Sdk;

/// <summary>
/// Error category carried by <see cref="SdkException"/>. Mirrors
/// <c>sdk/rust/src/error.rs</c>; every device error code and SDK-level
/// condition has a distinct value (docs/sdk-api-design.md §4).
/// </summary>
public enum ErrorCode
{
    // Device errors (from ERR responses)
    BadCommand,
    BadParam,
    BadMap,
    Busy,
    Flash,
    TooLong,
    NotArmed,
    SyncState,
    SyncTimeout,
    NoResource,
    UnknownDevice,

    // SDK errors
    Connection,
    Io,
    Parse,
    Timeout,
    NoDevice,
    MultipleDevices,
    Disconnected,
    UnsupportedFirmware,
}

/// <summary>Typed SDK error. All failures raised by the SDK are instances
/// of this class with a specific <see cref="Code"/>.</summary>
public class SdkException : Exception
{
    public ErrorCode Code { get; }

    public SdkException(ErrorCode code, string message)
        : base(message)
    {
        Code = code;
    }

    public SdkException(ErrorCode code, string message, Exception innerException)
        : base(message, innerException)
    {
        Code = code;
    }

    /// <summary>Map an <c>ERR &lt;code&gt;</c> response to a typed error.</summary>
    public static SdkException FromDeviceError(string code) => code switch
    {
        "BAD_CMD" => new(ErrorCode.BadCommand, "device error: BAD_CMD (unknown command)"),
        "UNKNOWN_CMD" => new(ErrorCode.BadCommand, "device error: UNKNOWN_CMD (unknown text command)"),
        "BAD_PARAM" => new(ErrorCode.BadParam, "device error: BAD_PARAM (invalid parameter)"),
        "BAD_MAP" => new(ErrorCode.BadMap, "device error: BAD_MAP (map validation failed)"),
        "BUSY" => new(ErrorCode.Busy, "device error: BUSY (device is busy)"),
        "FLASH" => new(ErrorCode.Flash, "device error: FLASH (flash write/read failed)"),
        "TOO_LONG" => new(ErrorCode.TooLong, "device error: TOO_LONG (payload too long)"),
        "LINE_TOO_LONG" => new(ErrorCode.TooLong, "device error: LINE_TOO_LONG (command line exceeds 128 bytes)"),
        "NOT_ARMED" => new(ErrorCode.NotArmed, "device error: NOT_ARMED (timestamp not armed)"),
        "SYNC_STATE" => new(ErrorCode.SyncState, "device error: SYNC_STATE (invalid sync state transition)"),
        "SYNC_TIMEOUT" => new(ErrorCode.SyncTimeout, "device error: SYNC_TIMEOUT (sync pulse not detected)"),
        "NO_RESOURCE" => new(ErrorCode.NoResource, "device error: NO_RESOURCE (required resource not configured)"),
        _ => new(ErrorCode.UnknownDevice, $"device error: {code}"),
    };

    /// <summary>Pre-Phase 9.6 firmware detected — never parsed silently.</summary>
    public static SdkException UnsupportedFirmware(string detail) =>
        new(ErrorCode.UnsupportedFirmware, $"unsupported firmware: {detail} (requires FW Phase 9.6+)");
}
