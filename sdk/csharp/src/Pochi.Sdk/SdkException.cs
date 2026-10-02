namespace Pochi.Sdk;

/// <summary>
/// Error category carried by <see cref="SdkException"/>. Mirrors
/// <c>sdk/rust/src/error.rs</c>; every error name the device can answer and
/// every SDK-level condition has a distinct value (docs/sdk-api-design.md
/// section 4).
/// </summary>
public enum ErrorCode
{
    // Device errors (from ERR responses)
    BadParam,
    BadMap,
    Busy,
    Flash,
    TooLong,
    NotArmed,
    SyncState,
    NoResource,
    NotRunning,
    UnknownCmd,
    LineTooLong,

    /// <summary>Binary transport only; a text device never answers it.</summary>
    BadCommand,

    /// <summary>HID transport only; a text device never answers it.</summary>
    TransportNotSupported,

    /// <summary>Any other <c>ERR &lt;NAME&gt;</c>; the raw name is in the message.</summary>
    UnknownDevice,

    // SDK errors
    Connection,
    Io,
    Parse,

    /// <summary>Rejected by host-side validation; nothing was sent.</summary>
    InvalidArgument,
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

    /// <summary>Map an <c>ERR &lt;NAME&gt;</c> response to a typed error. A
    /// name the SDK does not know is <see cref="ErrorCode.UnknownDevice"/> with
    /// the raw name preserved; it is never mapped to a default.</summary>
    public static SdkException FromDeviceError(string name) => name switch
    {
        "BAD_PARAM" => new(ErrorCode.BadParam, "device error: BAD_PARAM (invalid parameter)"),
        "BAD_MAP" => new(ErrorCode.BadMap, "device error: BAD_MAP (map validation failed)"),
        "BUSY" => new(ErrorCode.Busy, "device error: BUSY (device is busy)"),
        "FLASH" => new(ErrorCode.Flash, "device error: FLASH (flash write failed)"),
        "TOO_LONG" => new(ErrorCode.TooLong, "device error: TOO_LONG (payload too long)"),
        "NOT_ARMED" => new(ErrorCode.NotArmed, "device error: NOT_ARMED (timestamp not armed)"),
        "SYNC_STATE" => new(
            ErrorCode.SyncState, "device error: SYNC_STATE (invalid sync state transition)"),
        "NO_RESOURCE" => new(
            ErrorCode.NoResource, "device error: NO_RESOURCE (required pins not configured)"),
        "NOT_RUNNING" => new(
            ErrorCode.NotRunning, "device error: NOT_RUNNING (pattern not running)"),
        "UNKNOWN_CMD" => new(ErrorCode.UnknownCmd, "device error: UNKNOWN_CMD (unknown command)"),
        "LINE_TOO_LONG" => new(
            ErrorCode.LineTooLong, "device error: LINE_TOO_LONG (line exceeds 256 bytes)"),
        "BAD_CMD" => new(ErrorCode.BadCommand, "device error: BAD_CMD (unknown command id)"),
        "TRANSPORT_NOT_SUPPORTED" => new(
            ErrorCode.TransportNotSupported,
            "device error: TRANSPORT_NOT_SUPPORTED (command not available on this transport)"),
        _ => new(ErrorCode.UnknownDevice, $"device error: {name}"),
    };

    /// <summary>The device reported a protocol other than the one this SDK
    /// speaks; never parsed leniently.</summary>
    public static SdkException UnsupportedFirmware(string detail) =>
        new(ErrorCode.UnsupportedFirmware, $"unsupported protocol: {detail}");
}
