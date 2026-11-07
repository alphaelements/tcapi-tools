using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace Pochi.Sdk;

/// <summary>Wire-format JSON conversion. All SDKs serialize to identical
/// JSON: snake_case keys, lowercase string enums, explicit nulls
/// (docs/sdk-api-design.md §6). The C# API uses PascalCase; these helpers
/// convert at the serialization boundary.
///
/// The conversion is generated at build time (System.Text.Json source
/// generation, <see cref="WireJsonContext"/>), so it needs no runtime
/// reflection and works under trimming and NativeAOT. Only the wire types
/// registered on the context can be converted; any other type is rejected
/// with <see cref="ErrorCode.InvalidArgument"/>.</summary>
public static class WireJson
{
    /// <summary>Serialize a wire type to a wire-format JSON string.</summary>
    public static string Serialize<T>(T value) =>
        JsonSerializer.Serialize(value, TypeInfo<T>());

    /// <summary>Deserialize a wire-format JSON string.</summary>
    public static T Deserialize<T>(string json)
    {
        var info = TypeInfo<T>();
        T? value;
        try
        {
            value = JsonSerializer.Deserialize(json, info);
        }
        catch (JsonException ex)
        {
            throw new SdkException(ErrorCode.Parse, $"invalid wire JSON: {ex.Message}", ex);
        }

        return value ?? throw new SdkException(ErrorCode.Parse, "wire JSON is null");
    }

    private static JsonTypeInfo<T> TypeInfo<T>() =>
        WireJsonContext.Default.GetTypeInfo(typeof(T)) as JsonTypeInfo<T>
        ?? throw new SdkException(
            ErrorCode.InvalidArgument,
            $"{typeof(T).Name} is not a wire-format type");
}

/// <summary>Lowercase snake_case string form of an enum on the wire, with
/// the generic (AOT-safe) converter.</summary>
internal sealed class WireEnumConverter<TEnum> : JsonStringEnumConverter<TEnum>
    where TEnum : struct, Enum
{
    public WireEnumConverter()
        : base(JsonNamingPolicy.SnakeCaseLower)
    {
    }
}

/// <summary>Source-generated metadata for every type that crosses the wire
/// as JSON.</summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower,
    Converters =
    [
        typeof(WireEnumConverter<FailsafeCause>),
        typeof(WireEnumConverter<ResetCause>),
        typeof(WireEnumConverter<PatternMode>),
        typeof(WireEnumConverter<PatternState>),
        typeof(WireEnumConverter<EdgeMode>),
        typeof(WireEnumConverter<SyncRole>),
        typeof(WireEnumConverter<SyncState>),
    ])]
[JsonSerializable(typeof(DeviceInfo))]
[JsonSerializable(typeof(VersionInfo))]
[JsonSerializable(typeof(Capabilities))]
[JsonSerializable(typeof(IoState))]
[JsonSerializable(typeof(SafetyState))]
[JsonSerializable(typeof(ResetInfo))]
[JsonSerializable(typeof(Pads))]
[JsonSerializable(typeof(SafetyConfig))]
[JsonSerializable(typeof(PinMap))]
[JsonSerializable(typeof(PatternStep))]
[JsonSerializable(typeof(PatternStatus))]
[JsonSerializable(typeof(TsStatus))]
[JsonSerializable(typeof(TimestampEvent))]
[JsonSerializable(typeof(TimestampResult))]
[JsonSerializable(typeof(SourceEvent))]
[JsonSerializable(typeof(ReconcileGroup))]
[JsonSerializable(typeof(PairStats))]
[JsonSerializable(typeof(FailsafeCause))]
[JsonSerializable(typeof(ResetCause))]
[JsonSerializable(typeof(PatternMode))]
[JsonSerializable(typeof(PatternState))]
[JsonSerializable(typeof(EdgeMode))]
[JsonSerializable(typeof(SyncRole))]
[JsonSerializable(typeof(SyncState))]
internal sealed partial class WireJsonContext : JsonSerializerContext
{
}
