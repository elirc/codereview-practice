using System.Diagnostics;
using Billing.Core;

namespace Billing.Api.Infrastructure;

/// <summary>Assigns a request id, exposes it in the response header and the logging scope, and logs the request.</summary>
public sealed class RequestIdMiddleware(RequestDelegate next, ILogger<RequestIdMiddleware> logger)
{
    public const string HeaderName = "X-Request-Id";

    public async Task InvokeAsync(HttpContext context, RequestContext requestContext)
    {
        var requestId = Accept(context.Request.Headers[HeaderName].ToString()) ?? Guid.NewGuid().ToString("N");
        context.TraceIdentifier = requestId;
        requestContext.RequestId = requestId;
        context.Response.OnStarting(() =>
        {
            context.Response.Headers[HeaderName] = requestId;
            return Task.CompletedTask;
        });

        using (logger.BeginScope(new Dictionary<string, object> { ["RequestId"] = requestId }))
        {
            var started = Stopwatch.GetTimestamp();
            await next(context);
            logger.LogInformation(
                "{Method} {Path} responded {StatusCode} in {ElapsedMs:0.0} ms",
                context.Request.Method,
                context.Request.Path.Value,
                context.Response.StatusCode,
                Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }
    }

    private static string? Accept(string value) =>
        value.Length is > 0 and <= 128 && value.All(c => c is >= '!' and <= '~') ? value : null;
}
