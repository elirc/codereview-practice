using System.Text.Json;
using System.Text.Json.Serialization;

namespace Billing.Core.Json;

/// <summary>JSON settings shared by the HTTP API and the webhook event bodies.</summary>
public static class BillingJson
{
    public static JsonSerializerOptions Options { get; } = Create();

    /// <summary>Creates a new options instance with the project's JSON settings.</summary>
    public static JsonSerializerOptions Create()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        Apply(options);
        return options;
    }

    /// <summary>Applies the project's JSON settings to an existing options instance.</summary>
    public static void Apply(JsonSerializerOptions options)
    {
        options.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
        options.NumberHandling = JsonNumberHandling.Strict;
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower, allowIntegerValues: false));
        options.Converters.Add(new UtcInstantConverter());
    }
}
