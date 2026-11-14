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

        if (settings.WorkerLoops.Contains("refunds"))
        {
            services.AddHostedService<RefundLoop>();
        }

        if (settings.WorkerLoops.Contains("webhook-fanout"))
        {
            services.AddHostedService<WebhookFanOutLoop>();
        }

        if (settings.WorkerLoops.Contains("webhook-delivery"))
        {
            services.AddHostedService<WebhookDeliveryLoop>();
        }

        if (settings.WorkerLoops.Contains("purge"))
        {
            services.AddHostedService<PurgeLoop>();
        }

        return services;
    }
}
