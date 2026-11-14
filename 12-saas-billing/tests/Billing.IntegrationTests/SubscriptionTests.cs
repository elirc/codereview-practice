using Billing.Core.Data;
using Billing.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Billing.IntegrationTests;

public sealed class SubscriptionTests(BillingApp app) : IntegrationTest(app)
{
    private async Task<Guid> CatalogAsync(int trialDays = 0)
    {
        var product = await Data.ProductAsync();
        await Data.PlanAsync(product, "basic", [Items.Flat("Basic", 3000), Items.Seats("Seats", 1000)], trialDays: trialDays);
        await Data.PlanAsync(product, "euro", [Items.Flat("Euro", 3000)], currency: "EUR");
        return product;
    }

    [Fact]
    public async Task SubscriptionWithoutTrialIsActiveAndInvoicedAtOnce()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();

        var response = await Data.TrySubscribeAsync(customer, "basic", quantity: 3);

        Assert.Equal(201, response.Status);
        Assert.Equal("active", response["status"].GetString());
        Assert.Equal("2026-01-15", response["anchorDate"].GetString());
        Assert.Equal("2026-01-15", response["currentPeriodStart"].GetString());
        Assert.Equal("2026-02-15", response["currentPeriodEnd"].GetString());
        Assert.Equal("2026-02-15T01:00:00Z", response["nextBillingAt"].GetString());

        var invoice = Assert.Single(await Data.InvoicesAsync(response.Id));
        Assert.Equal("cycle", invoice.GetProperty("kind").GetString());
        Assert.Equal("open", invoice.GetProperty("status").GetString());
        Assert.Equal(6000, invoice.GetProperty("totalMinor").GetInt64());
        var lines = invoice.GetProperty("lines").EnumerateArray().ToList();
        Assert.Equal(new[] { "flat", "seats" }, lines.Select(l => l.GetProperty("kind").GetString()).ToArray());
        Assert.Equal(3, lines[1].GetProperty("quantity").GetInt64());
    }

    [Fact]
    public async Task SubscriptionWithTrialHasNoInvoiceUntilTheTrialEnds()
    {
        await CatalogAsync(trialDays: 14);
        var customer = await Data.CustomerAsync();

        var response = await Data.TrySubscribeAsync(customer, "basic");

        Assert.Equal(201, response.Status);
        Assert.Equal("trialing", response["status"].GetString());
        Assert.Equal("2026-01-29", response["trialEndsOn"].GetString());
        Assert.Equal("2026-01-29", response["anchorDate"].GetString());
        Assert.Equal("2026-01-29T00:00:00Z", response["nextBillingAt"].GetString());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, response["currentPeriodStart"].ValueKind);
        Assert.Empty(await Data.InvoicesAsync(response.Id));
    }

    [Fact]
    public async Task TrialDaysOverrideReplacesThePlanTrial()
    {
        await CatalogAsync(trialDays: 14);
        var customer = await Data.CustomerAsync();

        var response = await Data.TrySubscribeAsync(customer, "basic", trialDays: 0);

        Assert.Equal("active", response["status"].GetString());
        Assert.Single(await Data.InvoicesAsync(response.Id));
    }

    [Fact]
    public async Task PlanInAnotherCurrencyIsIncompatible()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync(currency: "USD");

        var response = await Data.TrySubscribeAsync(customer, "euro");

        Assert.Equal(422, response.Status);
        Assert.Equal("plan_incompatible", response.ErrorCode);
    }

    [Fact]
    public async Task RetiredPlanIsIncompatible()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();
        await (await Data.AdminAsync()).PostAsync("/v1/plans/basic/retire");

        var response = await Data.TrySubscribeAsync(customer, "basic");

        Assert.Equal(422, response.Status);
        Assert.Equal("plan_incompatible", response.ErrorCode);
    }

    [Fact]
    public async Task SecondLiveSubscriptionToTheSameProductIsAConflict()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();
        await Data.SubscribeAsync(customer, "basic");

        var response = await Data.TrySubscribeAsync(customer, "basic");

        Assert.Equal(409, response.Status);
        Assert.Equal("already_subscribed", response.ErrorCode);
    }

    [Fact]
    public async Task ConcurrentSubscriptionsToTheSameProductYieldOneSuccess()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();

        var results = await Task.WhenAll(
            Data.TrySubscribeAsync(customer, "basic"),
            Data.TrySubscribeAsync(customer, "basic"));

        Assert.Equal(new[] { 201, 409 }, results.Select(r => r.Status).Order().ToArray());
        var live = await App.WithDbAsync(db => db.Subscriptions.CountAsync(s => s.CustomerId == customer));
        Assert.Equal(1, live);
    }

    [Fact]
    public async Task ReplayedRequestReturnsTheStoredResponseAndCreatesNothing()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();

        var first = await Data.TrySubscribeAsync(customer, "basic", idempotencyKey: "replay-key-1");
        var second = await Data.TrySubscribeAsync(customer, "basic", idempotencyKey: "replay-key-1");

        Assert.Equal(201, second.Status);
        Assert.Equal(first.Text, second.Text);
        Assert.Single(await Data.InvoicesAsync(first.Id));
    }

    [Fact]
    public async Task BusinessErrorsAreStoredAndReplayed()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();

        var first = await Data.TrySubscribeAsync(customer, "euro", idempotencyKey: "replay-key-2");
        var second = await Data.TrySubscribeAsync(customer, "euro", idempotencyKey: "replay-key-2");

        Assert.Equal(422, second.Status);
        Assert.Equal(first.Text, second.Text);
    }

    [Fact]
    public async Task ReusingAKeyForADifferentRequestIsRejected()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();
        await Data.TrySubscribeAsync(customer, "basic", quantity: 1, idempotencyKey: "replay-key-3");

        var response = await Data.TrySubscribeAsync(customer, "basic", quantity: 2, idempotencyKey: "replay-key-3");

        Assert.Equal(422, response.Status);
        Assert.Equal("idempotency_key_reused", response.ErrorCode);
    }

    [Fact]
    public async Task MissingIdempotencyKeyIsRejected()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();
        var service = await Data.ServiceAsync();

        var response = await service.PostAsync("/v1/subscriptions", new { customerId = customer, planCode = "basic" });

        Assert.Equal(400, response.Status);
        Assert.Equal("idempotency_key_required", response.ErrorCode);
    }

    [Fact]
    public async Task TimezoneCannotChangeWhileASubscriptionIsLive()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();
        await Data.SubscribeAsync(customer, "basic");
        var service = await Data.ServiceAsync();

        var refused = await service.PatchAsync($"/v1/customers/{customer}", new { timezone = "Europe/Berlin" });
        var allowed = await service.PatchAsync($"/v1/customers/{customer}", new { name = "Renamed" });

        Assert.Equal(409, refused.Status);
        Assert.Equal("invalid_state", refused.ErrorCode);
        Assert.Equal(200, allowed.Status);
    }

    [Fact]
    public async Task SubscriptionCreationWritesEventsInOrder()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();

        await Data.SubscribeAsync(customer, "basic");

        var types = await App.WithDbAsync(db => db.WebhookEvents.OrderBy(e => e.Sequence).Select(e => e.Type).ToListAsync());
        Assert.Equal(new[] { "subscription.created", "invoice.finalized" }, types.ToArray());
    }
}
