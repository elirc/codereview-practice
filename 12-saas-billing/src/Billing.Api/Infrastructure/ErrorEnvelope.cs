using System.Text.Json;
using Billing.Core.Json;

namespace Billing.Api.Infrastructure;

/// <summary>Builds and writes the JSON error envelope.</summary>
public static class ErrorEnvelope
{
    /// <summary>Returns the serialised envelope for an error.</summary>
    public static string Serialize(string code, string message, object? details, string requestId) =>
        JsonSerializer.Serialize(
            new ErrorBody(new ErrorContent(code, message, details ?? new Dictionary<string, object?>(), requestId)),
            BillingJson.Options);

    /// <summary>Writes the envelope with the given status to the response.</summary>
    public static async Task WriteAsync(HttpContext context, int status, string code, string message, object? details)
    {
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsync(Serialize(code, message, details, context.TraceIdentifier), context.RequestAborted);
    }
}

internal sealed record ErrorBody(ErrorContent Error);

internal sealed record ErrorContent(string Code, string Message, object Details, string RequestId);
