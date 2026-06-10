using System.Text.Json;
using System.Text.Json.Serialization;

namespace Pochi.Sdk;

/// <summary>Wire-format JSON conversion. All SDKs serialize to identical
/// JSON: snake_case keys, lowercase string enums, explicit nulls
/// (docs/sdk-api-design.md §6). The C# API uses PascalCase; these helpers
/// convert at the serialization boundary.</summary>
public static class WireJson
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) },
    };

    /// <summary>Serialize a value to a wire-format JSON string.</summary>
    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    /// <summary>Deserialize a wire-format JSON string.</summary>
    public static T Deserialize<T>(string json)
    {
        T? value;
        try
        {
            value = JsonSerializer.Deserialize<T>(json, Options);
        }
        catch (JsonException ex)
        {
            throw new SdkException(ErrorCode.Parse, $"invalid wire JSON: {ex.Message}", ex);
        }

        return value ?? throw new SdkException(ErrorCode.Parse, "wire JSON is null");
    }
}
