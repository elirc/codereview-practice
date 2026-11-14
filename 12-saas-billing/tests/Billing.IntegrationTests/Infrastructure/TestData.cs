using System.Text.Json;
using Billing.Core.Data;

namespace Billing.IntegrationTests.Infrastructure;

/// <summary>Creates catalog entries and customers through the API.</summary>
public sealed class TestData(BillingApp app)
{
    private ApiClient? _admin;
    private ApiClient? _service;
    private int _customerCounter;

    public async Task<ApiClient> AdminAsync() => _admin ??= await app.ClientAsync(ApiRole.Admin);

    public async Task<ApiClient> ServiceAsync() => _service ??= await app.ClientAsync(ApiRole.Service);

    public async Task<Guid> ProductAsync(string name = "Platform")
    {
        var response = await (await AdminAsync()).PostAsync("/v1/products", new { name });
        Ensure(response, 201);
        return response.Id;
    }

    public async Task MeterAsync(string code, string aggregation = "sum")
    {
        var response = await (await AdminAsync()).PostAsync("/v1/meters", new { code, name = code, aggregation });
        Ensure(response, 201);
    }

    public async Task<JsonElement> PlanAsync(
        Guid productId,
        string code,
        object[] items,
        int trialDays = 0,
        string interval = "month",
        string currency = "USD")
    {
        var response = await (await AdminAsync()).PostAsync(
            "/v1/plans",
            new { productId, code, name = code, interval, currency, trialDays, items });
        Ensure(response, 201);
        return response.Json;
    }

    public async Task<Guid> CustomerAsync(
        string timezone = "Etc/UTC",
        string currency = "USD",
        string country = "US",
        string? region = null,
        string? token = "tok_ok",
        bool taxExempt = false)
    {
        var service = await ServiceAsync();
        var number = Interlocked.Increment(ref _customerCounter);
        var response = await service.PostAsync(
            "/v1/customers",
            new
            {
                externalId = $"cust-{number}-{Guid.NewGuid():N}",
                name = $"Customer {number}",
                email = $"customer{number}@example.com",
                currency,
                timezone,
                country,
                region,
                taxExempt,
            });
        Ensure(response, 201);
        if (token is not null)
        {
            Ensure(await service.PutAsync($"/v1/customers/{response.Id}/payment-method", new { token }), 200);
        }

        return response.Id;
    }

    public async Task TaxRateAsync(string country, string? region, int rateBps, string validFrom = "2020-01-01", string? validTo = null)
    {
        var response = await (await AdminAsync()).PostAsync(
            "/v1/tax-rates",
            new { country, region, rateBps, validFrom, validTo });
        Ensure(response, 201);
    }

    public async Task<ApiResponse> TrySubscribeAsync(Guid customerId, string planCode, int quantity = 1, int? trialDays = null, string? idempotencyKey = null) =>
        await (await ServiceAsync()).PostAsync(
            "/v1/subscriptions",
            new { customerId, planCode, quantity, trialDays },
            idempotencyKey ?? $"sub-{Guid.NewGuid():N}");

    public async Task<Guid> SubscribeAsync(Guid customerId, string planCode, int quantity = 1, int? trialDays = null)
    {
        var response = await TrySubscribeAsync(customerId, planCode, quantity, trialDays);
        Ensure(response, 201);
        return response.Id;
    }

    public async Task<JsonElement> SubscriptionAsync(Guid id) => (await (await ServiceAsync()).GetAsync($"/v1/subscriptions/{id}")).Json;

    /// <summary>Returns every invoice of the subscription, oldest first.</summary>
    public async Task<IReadOnlyList<JsonElement>> InvoicesAsync(Guid subscriptionId)
    {
        var customerId = (await SubscriptionAsync(subscriptionId)).GetProperty("customerId").GetGuid();
        var page = await (await ServiceAsync()).GetAsync($"/v1/invoices?customerId={customerId}&limit=200");
        return page["data"].EnumerateArray()
            .Where(i => i.GetProperty("subscriptionId").ValueKind != JsonValueKind.Null && i.GetProperty("subscriptionId").GetGuid() == subscriptionId)
            .OrderBy(i => i.GetProperty("createdAt").GetString(), StringComparer.Ordinal)
            .ThenBy(i => i.GetProperty("number").GetString(), StringComparer.Ordinal)
            .ToList();
    }

    public static void Ensure(ApiResponse response, int status)
    {
        if (response.Status != status)
        {
            throw new InvalidOperationException($"Expected {status} but got {response}");
        }
    }
}

/// <summary>Plan item bodies for plan creation requests.</summary>
public static class Items
{
    public static object Flat(string name, long amountMinor) => new { kind = "flat", name, unitAmountMinor = amountMinor };

    public static object Seats(string name, long unitAmountMinor) => new { kind = "per_seat", name, unitAmountMinor };

    public static object Usage(string meterCode, string tierMode, params (long? UpTo, long Unit, long Flat)[] tiers) => new
    {
        kind = "usage",
        name = meterCode,
        meterCode,
        tierMode,
        tiers = tiers.Select(t => new { upTo = t.UpTo, unitAmountMinor = t.Unit, flatAmountMinor = t.Flat }).ToArray(),
    };

    /// <summary>A usage item that charges a flat unit price for every unit.</summary>
    public static object PerUnit(string meterCode, long unitAmountMinor) =>
        Usage(meterCode, "volume", (null, unitAmountMinor, 0));
}
