using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Billing.IntegrationTests.Infrastructure;

/// <summary>An HTTP client authenticated with one API key.</summary>
public sealed class ApiClient
{
    private static readonly JsonSerializerOptions RequestJson = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;

    public ApiClient(HttpClient http, string? apiKey)
    {
        _http = http;
        if (apiKey is not null)
        {
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        }
    }

    public Task<ApiResponse> GetAsync(string path) => SendAsync(HttpMethod.Get, path, null, null);

    public Task<ApiResponse> PostAsync(string path, object? body = null, string? idempotencyKey = null) =>
        SendAsync(HttpMethod.Post, path, body, idempotencyKey);

    public Task<ApiResponse> PutAsync(string path, object body) => SendAsync(HttpMethod.Put, path, body, null);

    public Task<ApiResponse> PatchAsync(string path, object body) => SendAsync(HttpMethod.Patch, path, body, null);

    public Task<ApiResponse> DeleteAsync(string path) => SendAsync(HttpMethod.Delete, path, null, null);

    /// <summary>Sends a raw JSON text body.</summary>
    public async Task<ApiResponse> PostRawAsync(string path, string json)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        return await ReadAsync(request);
    }

    private async Task<ApiResponse> SendAsync(HttpMethod method, string path, object? body, string? idempotencyKey)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body, body.GetType(), options: RequestJson);
        }

        if (idempotencyKey is not null)
        {
            request.Headers.Add("Idempotency-Key", idempotencyKey);
        }

        return await ReadAsync(request);
    }

    private async Task<ApiResponse> ReadAsync(HttpRequestMessage request)
    {
        using var response = await _http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        return new ApiResponse((int)response.StatusCode, text);
    }
}

/// <summary>Status and body of one API response.</summary>
public sealed record ApiResponse(int Status, string Text)
{
    public JsonElement Json => Text.Length == 0 ? default : JsonDocument.Parse(Text).RootElement.Clone();

    public JsonElement this[string property] => Json.GetProperty(property);

    public string ErrorCode => Json.GetProperty("error").GetProperty("code").GetString() ?? string.Empty;

    public Guid Id => Json.GetProperty("id").GetGuid();

    public override string ToString() => $"{Status} {Text}";
}
