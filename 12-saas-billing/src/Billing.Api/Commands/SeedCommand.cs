using Billing.Core;
using Billing.Core.Data;
using Billing.Core.Services;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Billing.Api.Commands;

/// <summary>Creates a small development dataset; running it again changes nothing.</summary>
public static class SeedCommand
{
    /// <summary>Development API keys, one per role; listed in the README.</summary>
    public static readonly IReadOnlyDictionary<ApiRole, string> DevelopmentKeys = new Dictionary<ApiRole, string>
    {
        [ApiRole.Service] = "bk_dev_service_7c1e5a9d3f2b4e8a6d0c9b1f5e3a7d2c",
        [ApiRole.Support] = "bk_dev_support_2a8f4c6e0b9d1f3a5c7e9b2d4f6a8c0e",
        [ApiRole.BillingOps] = "bk_dev_billing_ops_9e3b7d1f5a2c8e4b6d0f3a9c1e5b7d2f",
        [ApiRole.Admin] = "bk_dev_admin_4d6f8a0c2e9b1d3f5a7c9e2b4d6f8a1c",
    };

    public static async Task<int> RunAsync(IServiceProvider services, CancellationToken ct = default)
    {
        await using var scope = services.CreateAsyncScope();
        var provider = scope.ServiceProvider;
        var environment = provider.GetRequiredService<IHostEnvironment>();
        var logger = provider.GetRequiredService<ILoggerFactory>().CreateLogger("Billing.Seed");
        if (environment.IsProduction())
        {
            logger.LogError("The seed command does not run in the Production environment");
            return 1;
        }

        provider.GetRequiredService<RequestContext>().RequestId = "seed";
        var db = provider.GetRequiredService<BillingDbContext>();
        var clock = provider.GetRequiredService<TimeProvider>();
        var catalog = provider.GetRequiredService<CatalogService>();
        var customers = provider.GetRequiredService<CustomerService>();
        var subscriptions = provider.GetRequiredService<SubscriptionService>();

        await SeedKeysAsync(db, clock, ct);
        var productId = await SeedCatalogAsync(db, catalog, ct);
        await SeedTaxRatesAsync(db, catalog, ct);

        var acme = await SeedCustomerAsync(db, customers, new NewCustomer("acme", "Acme Corp", "billing@acme.example", "USD", "America/Los_Angeles", "US", "CA", false), "tok_ok", ct);
        var kiwi = await SeedCustomerAsync(db, customers, new NewCustomer("kiwi", "Kiwi Labs", "accounts@kiwi.example", "USD", "Pacific/Auckland", "NZ", null, false), "tok_decline_card_declined", ct);
        var berlin = await SeedCustomerAsync(db, customers, new NewCustomer("berlin", "Berlin GmbH", "finanzen@berlin.example", "EUR", "Europe/Berlin", "DE", null, false), null, ct);

        await SeedSubscriptionAsync(db, subscriptions, acme, productId, new NewSubscription(acme, "team-monthly", 5, 0), ct);
        await SeedSubscriptionAsync(db, subscriptions, kiwi, productId, new NewSubscription(kiwi, "starter-monthly", 1, 14), ct);
        await SeedSubscriptionAsync(db, subscriptions, berlin, productId, new NewSubscription(berlin, "team-monthly-eur", 2, 0), ct);

        logger.LogInformation("Seed data is in place");
        return 0;
    }

    private static async Task SeedKeysAsync(BillingDbContext db, TimeProvider clock, CancellationToken ct)
    {
        foreach (var (role, key) in DevelopmentKeys)
        {
            var hash = Hashing.Sha256Hex(key);
            if (await db.ApiKeys.AnyAsync(k => k.KeyHash == hash, ct))
            {
                continue;
            }

            db.ApiKeys.Add(new ApiKey
            {
                Id = Ids.New(clock),
                Name = $"Development {Naming.EnumValue(role)} key",
                KeyHash = hash,
                Role = role,
                CreatedAt = clock.GetUtcNow(),
            });
        }

        await db.SaveChangesAsync(ct);
    }

    private static async Task<Guid> SeedCatalogAsync(BillingDbContext db, CatalogService catalog, CancellationToken ct)
    {
        var productId = await db.Products.Where(p => p.Name == "Platform").Select(p => (Guid?)p.Id).FirstOrDefaultAsync(ct)
            ?? (await catalog.CreateProductAsync("Platform", ct)).Id;

        if (!await db.Meters.AnyAsync(m => m.Code == "api_calls", ct))
        {
            await catalog.CreateMeterAsync("api_calls", "API calls", MeterAggregation.Sum, ct);
        }

        if (!await db.Meters.AnyAsync(m => m.Code == "peak_seats", ct))
        {
            await catalog.CreateMeterAsync("peak_seats", "Peak concurrent seats", MeterAggregation.Max, ct);
        }

        PriceTierSpec[] apiTiers = [new(10_000, 0, 0), new(100_000, 2, 0), new(null, 1, 0)];
        var plans = new[]
        {
            new NewPlan(productId, "starter-monthly", "Starter", BillingInterval.Month, "USD", 14, [new NewPlanItem(PlanItemKind.Flat, "Starter platform fee", 2900, null, null, [])]),
            new NewPlan(
                productId,
                "team-monthly",
                "Team",
                BillingInterval.Month,
                "USD",
                0,
                [
                    new NewPlanItem(PlanItemKind.Flat, "Team platform fee", 4900, null, null, []),
                    new NewPlanItem(PlanItemKind.PerSeat, "Seats", 1000, null, null, []),
                    new NewPlanItem(PlanItemKind.Usage, "API calls", null, "api_calls", TierMode.Graduated, apiTiers),
                ]),
            new NewPlan(
                productId,
                "team-yearly",
                "Team (yearly)",
                BillingInterval.Year,
                "USD",
                0,
                [
                    new NewPlanItem(PlanItemKind.Flat, "Team platform fee", 49_000, null, null, []),
                    new NewPlanItem(PlanItemKind.PerSeat, "Seats", 10_000, null, null, []),
                ]),
            new NewPlan(
                productId,
                "team-monthly-eur",
                "Team (EUR)",
                BillingInterval.Month,
                "EUR",
                0,
                [
                    new NewPlanItem(PlanItemKind.Flat, "Team platform fee", 4500, null, null, []),
                    new NewPlanItem(PlanItemKind.PerSeat, "Seats", 900, null, null, []),
                    new NewPlanItem(PlanItemKind.Usage, "Peak seats", null, "peak_seats", TierMode.Volume, [new(10, 500, 0), new(null, 400, 0)]),
                ]),
        };

        foreach (var plan in plans)
        {
            if (!await db.Plans.AnyAsync(p => p.Code == plan.Code, ct))
            {
                await catalog.CreatePlanAsync(plan, ct);
            }
        }

        return productId;
    }

    private static async Task SeedTaxRatesAsync(BillingDbContext db, CatalogService catalog, CancellationToken ct)
    {
        var rates = new[]
        {
            new NewTaxRate("US", "CA", 825, new DateOnly(2020, 1, 1), null),
            new NewTaxRate("DE", null, 1900, new DateOnly(2020, 1, 1), null),
            new NewTaxRate("NZ", null, 1500, new DateOnly(2020, 1, 1), null),
        };

        foreach (var rate in rates)
        {
            var exists = await db.TaxRates.AnyAsync(r => r.Country == rate.Country && r.Region == rate.Region, ct);
            if (!exists)
            {
                await catalog.CreateTaxRateAsync(rate, ct);
            }
        }
    }

    private static async Task<Guid> SeedCustomerAsync(
        BillingDbContext db,
        CustomerService customers,
        NewCustomer customer,
        string? token,
        CancellationToken ct)
    {
        var existing = await db.Customers.Where(c => c.ExternalId == customer.ExternalId).Select(c => (Guid?)c.Id).FirstOrDefaultAsync(ct);
        if (existing is { } id)
        {
            return id;
        }

        var created = await customers.CreateAsync(customer, ct);
        if (token is not null)
        {
            await customers.SetPaymentMethodAsync(created.Id, token, ct);
        }

        return created.Id;
    }

    private static async Task SeedSubscriptionAsync(
        BillingDbContext db,
        SubscriptionService subscriptions,
        Guid customerId,
        Guid productId,
        NewSubscription subscription,
        CancellationToken ct)
    {
        var live = await db.Subscriptions.AnyAsync(
            s => s.CustomerId == customerId && s.ProductId == productId && s.Status != SubscriptionStatus.Canceled,
            ct);
        if (!live)
        {
            await subscriptions.CreateAsync(subscription, ct);
        }
    }
}
