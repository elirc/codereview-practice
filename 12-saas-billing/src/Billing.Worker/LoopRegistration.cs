using Billing.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Billing.Worker;

/// <summary>Registers the loops listed in <c>WORKER_LOOPS</c>.</summary>
public static class LoopRegistration
{
    public static IServiceCollection AddLoops(this IServiceCollection services, BillingSettings settings)
    {
        if (settings.WorkerLoops.Contains("billing"))
        {
            services.AddHostedService<BillingRunLoop>();
        }

        if (settings.WorkerLoops.Contains("payments"))
        {
            services.AddHostedService<PaymentLoop>();
        }

        return services;
    }
}
