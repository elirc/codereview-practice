using Billing.Core.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
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

        services.AddDbContext<BillingDbContext>(options => options
            .UseNpgsql(settings.ConnectionString)
            // The snapshot is maintained by hand next to the migrations; drift is logged by the migrate command.
            .ConfigureWarnings(w => w.Log(RelationalEventId.PendingModelChangesWarning)));

        return services;
    }
}
