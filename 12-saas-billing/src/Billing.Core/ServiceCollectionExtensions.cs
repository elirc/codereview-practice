using Billing.Core.Data;
using Billing.Core.Payments;
using Billing.Core.Services;
using Billing.Core.Views;
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

        services.TryAddSingleton<ISecretGenerator, RandomSecretGenerator>();
        services.AddScoped<ApiKeyService>();
        services.AddScoped<CustomerService>();
        services.AddScoped<CatalogService>();
        services.AddScoped<ViewLoader>();
        services.AddScoped<EventRecorder>();
        services.AddScoped<CreditLedger>();
        services.AddScoped<DocumentNumberer>();
        services.AddScoped<InvoiceFinalizer>();
        services.AddScoped<InvoiceService>();
        services.AddScoped<SubscriptionCycle>();
        services.AddScoped<SubscriptionService>();
        services.AddScoped<UsageRating>();
        services.AddScoped<UsageService>();
        services.AddScoped<SubscriptionLifecycle>();
        services.AddScoped<SubscriptionBiller>();
        services.AddScoped<BillingRun>();
        services.AddScoped<InvoiceSettlement>();
        services.AddScoped<InvoiceCollector>();
        services.AddScoped<PaymentRun>();
        services.AddScoped<PaymentService>();
        services.TryAddSingleton<FakeGateway>();
        services.TryAddSingleton<IPaymentGateway>(sp => sp.GetRequiredService<FakeGateway>());

        return services;
    }
}
