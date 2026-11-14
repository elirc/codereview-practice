using System.Text.Json;
using Billing.Core.Errors;
using Microsoft.AspNetCore.Diagnostics;

namespace Billing.Api.Infrastructure;

/// <summary>Maps every exception that reaches the pipeline to the error envelope.</summary>
public sealed class ApiExceptionHandler(ILogger<ApiExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        switch (exception)
        {
            case DomainException domain:
                {
                    await ErrorEnvelope.WriteAsync(httpContext, domain.Status, domain.Code, domain.Message, domain.Details);
                    return true;
                }

            case BadHttpRequestException badRequest when badRequest.StatusCode == StatusCodes.Status413PayloadTooLarge:
                {
                    await ErrorEnvelope.WriteAsync(httpContext, 413, ErrorCodes.PayloadTooLarge, "The request body is too large.", null);
                    return true;
                }

            case BadHttpRequestException badRequest when badRequest.StatusCode == StatusCodes.Status415UnsupportedMediaType:
                {
                    await ErrorEnvelope.WriteAsync(httpContext, 415, ErrorCodes.UnsupportedMediaType, "The request body must be application/json.", null);
                    return true;
                }

            case BadHttpRequestException badRequest:
                {
                    var failure = DescribeReadFailure(badRequest);
                    await ErrorEnvelope.WriteAsync(
                        httpContext,
                        400,
                        ErrorCodes.ValidationFailed,
                        "The request could not be read.",
                        new ValidationDetails([failure]));
                    return true;
                }

            default:
                {
                    logger.LogError(
                        exception,
                        "Unhandled exception for {Method} {Path}",
                        httpContext.Request.Method,
                        httpContext.Request.Path.Value);
                    await ErrorEnvelope.WriteAsync(httpContext, 500, ErrorCodes.InternalError, "An unexpected error occurred.", null);
                    return true;
                }
        }
    }

    private static FieldError DescribeReadFailure(BadHttpRequestException exception)
    {
        if (exception.InnerException is JsonException json)
        {
            var path = json.Path is null ? string.Empty : json.Path.TrimStart('$').TrimStart('.');
            var message = json.Message.Contains("could not be mapped", StringComparison.Ordinal)
                ? "Is not a recognised field."
                : "Has an invalid value or the body is not valid JSON.";
            return new FieldError(path, message);
        }

        return new FieldError(string.Empty, "The request body or a parameter is missing or malformed.");
    }
}
