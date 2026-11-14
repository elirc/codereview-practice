using System.Text.Json;

namespace Billing.Api.Infrastructure;

/// <summary>Configures JSON console logging for the API process.</summary>
public static class LoggingSetup
{
    public static ILoggingBuilder AddBillingLogging(this ILoggingBuilder logging)
    {
        logging.ClearProviders();
        logging.AddJsonConsole(options =>
        {
            options.IncludeScopes = true;
            options.UseUtcTimestamp = true;
            options.TimestampFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z' ";
            options.JsonWriterOptions = new JsonWriterOptions { Indented = false };
        });
        logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
        logging.AddFilter("Microsoft.EntityFrameworkCore", LogLevel.Warning);
        return logging;
    }
}
