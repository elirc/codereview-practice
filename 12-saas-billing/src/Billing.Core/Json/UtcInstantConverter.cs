using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Billing.Core.Json;

/// <summary>Reads ISO-8601 instants that carry an offset and writes them in UTC with a trailing Z.</summary>
public sealed class UtcInstantConverter : JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
        {
            throw new JsonException("Expected an ISO-8601 instant string.");
        }

        var text = reader.GetString();
        if (text is null
            || !HasOffset(text)
            || !DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out var value))
        {
            throw new JsonException("Expected an ISO-8601 instant with a UTC offset.");
        }

        return value.ToUniversalTime();
    }

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", CultureInfo.InvariantCulture));

    private static bool HasOffset(string text)
    {
        var timeStart = text.IndexOf('T');
        if (timeStart < 0)
        {
            return false;
        }

        var time = text[timeStart..];
        return time.EndsWith('Z') || time.EndsWith('z') || time.IndexOfAny(['+', '-']) > 0;
    }
}
