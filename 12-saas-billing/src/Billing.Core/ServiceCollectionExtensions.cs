using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Billing.Core;

/// <summary>Registers the services shared by the API and the worker.</summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddBillingCore(this IServiceCollection services, BillingSettings settings)
    {
        services.AddSingleton(settings);
        services.TryAddSingleton(TimeProvider.System);
        services.AddScoped<RequestContext>();
        return services;
    }
}
