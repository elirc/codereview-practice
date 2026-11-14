using System.Text.Json;
using Billing.Core.Data;
using Billing.Core.Services;
using Billing.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Billing.IntegrationTests;

public sealed class ChangeAndCancelTests(BillingApp app) : IntegrationTest(app)
{
    private Guid _product;

    public override async Task InitializeAsync()
    {
        await base.InitializeAsync();
        _product = await Data.ProductAsync();
        await Data.MeterAsync("api_calls");
        await Data.PlanAsync(_product, "basic", [Items.Flat("Basic", 3000), Items.PerUnit("api_calls", 1)]);
        await Data.PlanAsync(_product, "pro", [Items.Flat("Pro", 5000)]);
        await Data.PlanAsync(_product, "pro-metered", [Items.Flat("Pro", 5000), Items.PerUnit("api_calls", 2)]);
        await Data.PlanAsync(_product, "mini", [Items.Flat("Mini", 1000), Items.PerUnit("api_calls", 1)]);
        await Data.PlanAsync(_product, "seats", [Items.Seats("Seats", 1000)]);
        await Data.PlanAsync(_product, "trial", [Items.Flat("Trial", 3000)], trialDays: 14);
    }

    private async Task<ApiResponse> ChangeAsync(Guid subscriptionId, string? planCode = null, int? quantity = null, string? key = null) =>
        await (await Data.ServiceAsync()).PostAsync(
            $"/v1/subscriptions/{subscriptionId}/change",
            new { planCode, quantity },
            key ?? $"change-{Guid.NewGuid():N}");

    private async Task<ApiResponse> CancelAsync(Guid subscriptionId, string mode) =>
        await (await Data.ServiceAsync()).PostAsync($"/v1/subscriptions/{subscriptionId}/cancel", new { mode }, $"cancel-{Guid.NewGuid():N}");

    private async Task<IReadOnlyList<(string Status, string? Reason)>> SendUsageAsync(Guid subscriptionId, string key, long quantity, DateTimeOffset at)
    {
        var response = await (await Data.ServiceAsync()).PostAsync(
            "/v1/usage-events",
            new { events = new[] { new { eventKey = key, subscriptionId, meterCode = "api_calls", quantity, occurredAt = at } } });
        TestData.Ensure(response, 200);
        return response["results"].EnumerateArray()
            .Select(r => (r.GetProperty("status").GetString()!, r.GetProperty("reason").ValueKind == JsonValueKind.Null ? null : r.GetProperty("reason").GetString()))
            .ToList();
    }

    private static long[] Amounts(JsonElement invoice) =>
        invoice.GetProperty("lines").EnumerateArray().Select(l => l.GetProperty("amountMinor").GetInt64()).ToArray();

    private Task RunBillingAsync() => App.RunLoopAsync<BillingRun>();

    [Fact]
    public async Task UpgradeProratesEachLineAndTaxesItOnItsOwn()
    {
        await Data.TaxRateAsync("US", null, 825);
        Clock.Set(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");

        Clock.Set(new DateTimeOffset(2026, 1, 22, 12, 0, 0, TimeSpan.Zero));
        var response = await ChangeAsync(sub, "pro");

        Assert.Equal(200, response.Status);
        Assert.Equal("pro", response["planCode"].GetString());
        var proration = (await Data.InvoicesAsync(sub)).Single(i => i.GetProperty("kind").GetString() == "proration");
        Assert.Equal(new long[] { -968, 1613 }, Amounts(proration));
        Assert.Equal(
            new long[] { -80, 133 },
            proration.GetProperty("lines").EnumerateArray().Select(l => l.GetProperty("taxMinor").GetInt64()).ToArray());
        Assert.Equal(698, proration.GetProperty("totalMinor").GetInt64());
        Assert.Equal("2026-01-22", proration.GetProperty("periodStart").GetString());
        Assert.Equal("2026-02-01", proration.GetProperty("periodEnd").GetString());
    }

    [Fact]
    public async Task SeatIncreaseCreditsOldSeatsAndChargesNewOnes()
    {
        Clock.Set(new DateTimeOffset(2026, 4, 1, 12, 0, 0, TimeSpan.Zero));
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "seats", quantity: 3);

        Clock.Set(new DateTimeOffset(2026, 4, 16, 12, 0, 0, TimeSpan.Zero));
        await ChangeAsync(sub, quantity: 5);

        var proration = (await Data.InvoicesAsync(sub)).Single(i => i.GetProperty("kind").GetString() == "proration");
        Assert.Equal(new long[] { -1500, 2500 }, Amounts(proration));
        Assert.Equal(5, (await Data.SubscriptionAsync(sub)).GetProperty("quantity").GetInt32());
    }

    [Fact]
    public async Task UpgradeOnTheFirstDayUsesFullAmountsAndOnTheLastDayOneDay()
    {
        Clock.Set(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));
        var first = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");
        var last = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");

        Clock.Set(new DateTimeOffset(2026, 1, 1, 18, 0, 0, TimeSpan.Zero));
        await ChangeAsync(first, "pro");
        Clock.Set(new DateTimeOffset(2026, 1, 31, 18, 0, 0, TimeSpan.Zero));
        await ChangeAsync(last, "pro");

        var firstDay = (await Data.InvoicesAsync(first)).Single(i => i.GetProperty("kind").GetString() == "proration");
        var lastDay = (await Data.InvoicesAsync(last)).Single(i => i.GetProperty("kind").GetString() == "proration");
        Assert.Equal(new long[] { -3000, 5000 }, Amounts(firstDay));
        Assert.Equal(new long[] { -97, 161 }, Amounts(lastDay));
    }

    [Fact]
    public async Task UpgradeToAPlanWithoutAMeterBillsThatMetersUsageOnce()
    {
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");
        Clock.Set(new DateTimeOffset(2026, 1, 20, 12, 0, 0, TimeSpan.Zero));
        await SendUsageAsync(sub, "u1", 100, Clock.GetUtcNow().AddHours(-1));

        await ChangeAsync(sub, "pro");

        var proration = (await Data.InvoicesAsync(sub)).Single(i => i.GetProperty("kind").GetString() == "proration");
        var usageLine = Assert.Single(proration.GetProperty("lines").EnumerateArray(), l => l.GetProperty("kind").GetString() == "usage");
        Assert.Equal(100, usageLine.GetProperty("amountMinor").GetInt64());

        Clock.Set(new DateTimeOffset(2026, 2, 15, 1, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();

        var boundary = (await Data.InvoicesAsync(sub)).Last();
        Assert.Equal("cycle", boundary.GetProperty("kind").GetString());
        Assert.Equal(new long[] { 5000 }, Amounts(boundary));
    }

    [Fact]
    public async Task DowngradeIsScheduledReplacedAndAppliedAtTheBoundary()
    {
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "pro-metered");
        Clock.Set(new DateTimeOffset(2026, 1, 20, 12, 0, 0, TimeSpan.Zero));
        await SendUsageAsync(sub, "u1", 100, Clock.GetUtcNow());

        var first = await ChangeAsync(sub, "basic");
        var second = await ChangeAsync(sub, "mini");

        Assert.Equal("basic", first["pendingPlanCode"].GetString());
        Assert.Equal("mini", second["pendingPlanCode"].GetString());
        Assert.Equal("pro-metered", second["planCode"].GetString());
        Assert.Single(await Data.InvoicesAsync(sub));

        Clock.Set(new DateTimeOffset(2026, 2, 15, 1, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();

        var boundary = (await Data.InvoicesAsync(sub)).Last();
        Assert.Equal(new long[] { 200, 1000 }, Amounts(boundary));
        var subscription = await Data.SubscriptionAsync(sub);
        Assert.Equal("mini", subscription.GetProperty("planCode").GetString());
        Assert.Equal(JsonValueKind.Null, subscription.GetProperty("pendingPlanId").ValueKind);
    }

    [Fact]
    public async Task ChangeAfterThePeriodEndBeforeTheRunIsRefused()
    {
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");
        Clock.Set(new DateTimeOffset(2026, 2, 15, 0, 30, 0, TimeSpan.Zero));

        var response = await ChangeAsync(sub, "pro");

        Assert.Equal(409, response.Status);
        Assert.Equal("renewal_in_progress", response.ErrorCode);
    }

    [Fact]
    public async Task ReplayedChangeCreatesOneProrationInvoice()
    {
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");
        Clock.Set(new DateTimeOffset(2026, 1, 20, 12, 0, 0, TimeSpan.Zero));

        var first = await ChangeAsync(sub, "pro", key: "change-replay-1");
        var second = await ChangeAsync(sub, "pro", key: "change-replay-1");

        Assert.Equal(first.Text, second.Text);
        Assert.Single(await Data.InvoicesAsync(sub), i => i.GetProperty("kind").GetString() == "proration");
    }

    [Fact]
    public async Task PlanOfAnotherProductIsIncompatible()
    {
        var other = await Data.ProductAsync("Other");
        await Data.PlanAsync(other, "other", [Items.Flat("Other", 9000)]);
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");

        var response = await ChangeAsync(sub, "other");

        Assert.Equal(422, response.Status);
        Assert.Equal("plan_incompatible", response.ErrorCode);
    }

    [Fact]
    public async Task ChangeDuringTrialAppliesWithoutAnInvoice()
    {
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "trial");

        var response = await ChangeAsync(sub, quantity: 4);

        Assert.Equal(4, response["quantity"].GetInt32());
        Assert.Empty(await Data.InvoicesAsync(sub));
    }

    [Fact]
    public async Task CancelAtPeriodEndBillsOnlyTheLastPeriodsUsage()
    {
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");
        Clock.Set(new DateTimeOffset(2026, 1, 20, 12, 0, 0, TimeSpan.Zero));
        await SendUsageAsync(sub, "u1", 250, Clock.GetUtcNow());
        var scheduled = await CancelAsync(sub, "period_end");
        Assert.True(scheduled["cancelAtPeriodEnd"].GetBoolean());
        Assert.Equal(409, (await ChangeAsync(sub, "pro")).Status);

        Clock.Set(new DateTimeOffset(2026, 2, 15, 1, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();
        await RunBillingAsync();

        var invoices = await Data.InvoicesAsync(sub);
        Assert.Equal(2, invoices.Count);
        Assert.Equal("final", invoices[1].GetProperty("kind").GetString());
        Assert.Equal(new long[] { 250 }, Amounts(invoices[1]));
        var subscription = await Data.SubscriptionAsync(sub);
        Assert.Equal("canceled", subscription.GetProperty("status").GetString());
        Assert.Equal("2026-02-15", subscription.GetProperty("endedOn").GetString());
    }

    [Fact]
    public async Task CancelAtPeriodEndWithoutUsageProducesNoInvoice()
    {
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");
        await CancelAsync(sub, "period_end");

        Clock.Set(new DateTimeOffset(2026, 2, 15, 1, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();

        Assert.Single(await Data.InvoicesAsync(sub));
        Assert.Equal("canceled", (await Data.SubscriptionAsync(sub)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task ResumeBeforeTheBoundaryRestoresNormalBilling()
    {
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");
        await CancelAsync(sub, "period_end");

        var resumed = await (await Data.ServiceAsync()).PostAsync($"/v1/subscriptions/{sub}/resume");
        Clock.Set(new DateTimeOffset(2026, 2, 15, 1, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();

        Assert.False(resumed["cancelAtPeriodEnd"].GetBoolean());
        var invoices = await Data.InvoicesAsync(sub);
        Assert.Equal("cycle", invoices[1].GetProperty("kind").GetString());
        Assert.Equal("active", (await Data.SubscriptionAsync(sub)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task ImmediateCancelBillsUsageUpToNowAndRejectsLaterEvents()
    {
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");
        Clock.Set(new DateTimeOffset(2026, 1, 20, 12, 0, 0, TimeSpan.Zero));
        await SendUsageAsync(sub, "u1", 40, Clock.GetUtcNow().AddMinutes(-10));

        var canceled = await CancelAsync(sub, "immediate");
        var later = await SendUsageAsync(sub, "u2", 5, Clock.GetUtcNow().AddMinutes(-20));
        var again = await CancelAsync(sub, "immediate");

        Assert.Equal("canceled", canceled["status"].GetString());
        Assert.Equal("2026-01-20", canceled["endedOn"].GetString());
        Assert.Equal("requested", canceled["cancelReason"].GetString());
        var final = Assert.Single(await Data.InvoicesAsync(sub), i => i.GetProperty("kind").GetString() == "final");
        Assert.Equal(new long[] { 40 }, Amounts(final));
        Assert.Equal(("rejected", "subscription_ended"), later[0]);
        Assert.Equal(409, again.Status);

        var types = await App.WithDbAsync(db => db.WebhookEvents.Select(e => e.Type).ToListAsync());
        Assert.Contains("subscription.canceled", types);
    }

    [Fact]
    public async Task CancelDuringTrialProducesNothing()
    {
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "trial");

        var response = await CancelAsync(sub, "period_end");

        Assert.Equal("canceled", response["status"].GetString());
        Assert.Empty(await Data.InvoicesAsync(sub));
        Clock.Set(new DateTimeOffset(2026, 2, 1, 0, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();
        Assert.Empty(await Data.InvoicesAsync(sub));
    }

    [Fact]
    public async Task SubscriptionsCanBeCreatedAgainAfterCancellation()
    {
        var customer = await Data.CustomerAsync();
        var sub = await Data.SubscribeAsync(customer, "basic");
        await CancelAsync(sub, "immediate");

        var again = await Data.TrySubscribeAsync(customer, "pro");

        Assert.Equal(201, again.Status);
        Assert.Equal(2, await App.WithDbAsync(db => db.Subscriptions.CountAsync(s => s.CustomerId == customer)));
    }
}
