using Billing.Api.Validation;
using Billing.Core.Errors;
using Billing.Core.Json;
using Microsoft.AspNetCore.Http.Json;

namespace Billing.Api.Infrastructure;

/// <summary>Service registration and request pipeline of the HTTP API.</summary>
public static class ApiSetup
{
    public static IServiceCollection AddBillingApi(this IServiceCollection services)
    {
        services.Configure<JsonOptions>(options => BillingJson.Apply(options.SerializerOptions));
        services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
        services.AddExceptionHandler<ApiExceptionHandler>();
        services.AddValidators();
        return services;
    }

    public static WebApplication UseBillingApi(this WebApplication app)
    {
        app.UseMiddleware<RequestIdMiddleware>();
        app.UseExceptionHandler(_ => { });

        app.MapGet("/health", () => Results.Ok(new HealthView("ok")));

        app.MapFallback(_ => throw DomainException.NotFound("The requested resource"));
        return app;
    }
}

/// <summary>Response of the health endpoint.</summary>
public sealed record HealthView(string Status);
