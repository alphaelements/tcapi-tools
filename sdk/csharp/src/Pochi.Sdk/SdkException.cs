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

    /// <summary><c>ERR FAILSAFE</c>: the failsafe latch is set and the command
    /// would move an output away from its <c>def</c>. Check <c>safety</c>, then
    /// <c>failsafe clear</c>.</summary>
    Failsafe,

    /// <summary><c>ERR EXCLUSIVE group=&lt;i&gt; mask=0x%08x</c>: the instruction would put
    /// two or more pins of an exclusive group ON. Raised as
    /// <see cref="ExclusiveException"/>, which carries the group and its mask.</summary>
    Exclusive,

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

    /// <summary>The <c>safety</c> / <c>excl get</c> read-back after
    /// <see cref="Connection.ApplySafety"/> differs from the applied file (the
    /// message lists the differences).</summary>
    SafetyMismatch,
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

    /// <summary>Map the text after <c>ERR </c> to a typed error. The first
    /// token is the error name; further <c>key=value</c> tokens are data and
    /// never make the line unparseable. <c>EXCLUSIVE</c> reads <c>group=</c> and
    /// <c>mask=</c> from them (an <c>EXCLUSIVE</c> line without both is a
    /// protocol violation, <see cref="ErrorCode.Parse"/>, never a default);
    /// for the other known names the data tokens are ignored. A name the SDK
    /// does not know is <see cref="ErrorCode.UnknownDevice"/> with the whole
    /// text preserved; it is never mapped to a default.</summary>
    public static SdkException FromDeviceError(string text)
    {
        var tokens = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var name = tokens.Length > 0 ? tokens[0] : "";
        return name switch
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
            "UNKNOWN_CMD" => new(
                ErrorCode.UnknownCmd, "device error: UNKNOWN_CMD (unknown command)"),
            "LINE_TOO_LONG" => new(
                ErrorCode.LineTooLong, "device error: LINE_TOO_LONG (line exceeds 256 bytes)"),
            "BAD_CMD" => new(ErrorCode.BadCommand, "device error: BAD_CMD (unknown command id)"),
            "TRANSPORT_NOT_SUPPORTED" => new(
                ErrorCode.TransportNotSupported,
                "device error: TRANSPORT_NOT_SUPPORTED (command not available on this transport)"),
            "FAILSAFE" => new(
                ErrorCode.Failsafe, "device error: FAILSAFE (failsafe latch is set)"),
            "EXCLUSIVE" => Exclusive(text, tokens),
            _ => new(ErrorCode.UnknownDevice, $"device error: {text}"),
        };
    }

    private static SdkException Exclusive(string text, string[] tokens)
    {
        byte? group = null;
        uint? mask = null;
        foreach (var token in tokens.Skip(1))
        {
            var eq = token.IndexOf('=');
            if (eq < 0)
            {
                continue;
            }

            var key = token[..eq];
            var value = token[(eq + 1)..];
            if (key == "group" && group is null)
            {
                group = byte.TryParse(
                    value, System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture, out var g)
                    ? g
                    : null;
            }
            else if (key == "mask" && mask is null)
            {
                mask = Protocol.TryParseU32(value);
            }
        }

        return group is { } gr && mask is { } m
            ? new ExclusiveException(gr, m)
            : new SdkException(
                ErrorCode.Parse,
                $"malformed ERR EXCLUSIVE (expected group=<i> mask=0x%08x): ERR {text}");
    }

    /// <summary>The device reported a protocol other than the one this SDK
    /// speaks; never parsed leniently.</summary>
    public static SdkException UnsupportedFirmware(string detail) =>
        new(ErrorCode.UnsupportedFirmware, $"unsupported protocol: {detail}");
}

/// <summary><c>ERR EXCLUSIVE group=&lt;i&gt; mask=0x%08x</c>: the instruction would put
/// two or more pins of an exclusive group ON. <see cref="SdkException.Code"/>
/// is <see cref="ErrorCode.Exclusive"/>.</summary>
public sealed class ExclusiveException : SdkException
{
    public ExclusiveException(byte group, uint mask)
        : base(
            ErrorCode.Exclusive,
            $"device error: EXCLUSIVE (exclusive group {group} would be violated, mask 0x{mask:x8})")
    {
        Group = group;
        Mask = mask;
    }

    /// <summary>0-based index of the first violating group.</summary>
    public byte Group { get; }

    /// <summary>The pin mask of that group.</summary>
    public uint Mask { get; }
}
