using System.Net.Http.Headers;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Webhooks;

/// <summary>Outcome of one webhook request: the status code, or an error when no response arrived.</summary>
public sealed record DeliveryOutcome(int? StatusCode, string? Error)
{
    public bool Succeeded => StatusCode is >= 200 and < 300;
}

/// <summary>Posts signed webhook bodies to endpoints.</summary>
public sealed class WebhookSender(IHttpClientFactory clients, ILogger<WebhookSender> logger)
{
    public const string ClientName = "webhooks";
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);

    /// <summary>Posts the body bytes unchanged with the given headers and returns the outcome.</summary>
    public async Task<DeliveryOutcome> SendAsync(string url, byte[] body, IReadOnlyDictionary<string, string> headers, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new ByteArrayContent(body);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        foreach (var (name, value) in headers)
        {
            request.Headers.TryAddWithoutValidation(name, value);
        }

        var client = clients.CreateClient(ClientName);
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            return new DeliveryOutcome((int)response.StatusCode, null);
        }
        catch (HttpRequestException ex)
        {
            logger.LogInformation("Webhook request to {Host} failed: {Error}", request.RequestUri?.Host, ex.Message);
            return new DeliveryOutcome(null, "connection_error");
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return new DeliveryOutcome(null, "timeout");
        }
    }
}
