using System.Net;

namespace Billing.IntegrationTests.Infrastructure;

/// <summary>One webhook request as received.</summary>
public sealed record RecordedRequest(Uri Url, byte[] Body, IReadOnlyDictionary<string, string> Headers, string? ContentType)
{
    public string Header(string name) => Headers[name];
}

/// <summary>Answers webhook requests from a script and records them.</summary>
public sealed class RecordingWebhookHandler : HttpMessageHandler
{
    private readonly object _gate = new();
    private readonly List<RecordedRequest> _requests = [];

    /// <summary>Chooses the status code for a request; 200 unless a test sets otherwise.</summary>
    public Func<RecordedRequest, HttpStatusCode> Respond { get; set; } = _ => HttpStatusCode.OK;

    public IReadOnlyList<RecordedRequest> Requests
    {
        get
        {
            lock (_gate)
            {
                return [.. _requests];
            }
        }
    }

    public void Reset()
    {
        lock (_gate)
        {
            _requests.Clear();
            Respond = _ => HttpStatusCode.OK;
        }
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        var headers = request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);
        var recorded = new RecordedRequest(request.RequestUri!, body, headers, request.Content?.Headers.ContentType?.ToString());
        Func<RecordedRequest, HttpStatusCode> respond;
        lock (_gate)
        {
            _requests.Add(recorded);
            respond = Respond;
        }

        return new HttpResponseMessage(respond(recorded));
    }
}
