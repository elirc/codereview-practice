using System.Text.Json;
using Billing.Core.Services;
using Billing.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Billing.IntegrationTests;

[Collection(DatabaseCollection.Name)]
public sealed class LongOutageTests(BillingApp app) : IntegrationTest(app)
{
    private Task RunBillingAsync() => App.RunLoopAsync<BillingRun>();

    private async Task SendUsageAsync(Guid subscriptionId, string key, long quantity)
    {
        var response = await (await Data.ServiceAsync()).PostAsync(
            "/v1/usage-events",
            new { events = new[] { new { eventKey = key, subscriptionId, meterCode = "api_calls", quantity, occurredAt = Clock.GetUtcNow() } } });
        Assert.Equal("accepted", response["results"][0].GetProperty("status").GetString());
    }

    [Fact]
    public async Task ThreeMonthOutageBillsEachPeriodOnceWithItsOwnUsage()
    {
        var product = await Data.ProductAsync();
        await Data.MeterAsync("api_calls");
        await Data.PlanAsync(product, "metered", [Items.Flat("Platform", 1000), Items.PerUnit("api_calls", 1)]);
        var subscription = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");

        Clock.Set(new DateTimeOffset(2026, 2, 1, 12, 0, 0, TimeSpan.Zero));
        await SendUsageAsync(subscription, "jan", 11);
        Clock.Set(new DateTimeOffset(2026, 3, 1, 12, 0, 0, TimeSpan.Zero));
        await SendUsageAsync(subscription, "feb", 22);
        Clock.Set(new DateTimeOffset(2026, 4, 1, 12, 0, 0, TimeSpan.Zero));
        await SendUsageAsync(subscription, "mar", 33);

        Clock.Set(new DateTimeOffset(2026, 4, 20, 0, 0, 0, TimeSpan.Zero));
        for (var pass = 0; pass < 6; pass++)
        {
            await RunBillingAsync();
        }

        var invoices = await Data.InvoicesAsync(subscription);
        Assert.Equal(new[] { "2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15" }, invoices.Select(i => i.GetProperty("periodStart").GetString()).ToArray());
        Assert.Equal(new long[] { 1000, 1011, 1022, 1033 }, invoices.Select(i => i.GetProperty("totalMinor").GetInt64()).ToArray());
        Assert.All(
            invoices.Skip(1).Zip(new[] { "2026-01-15", "2026-02-15", "2026-03-15" }),
            pair => Assert.Equal(pair.Second, UsageLine(pair.First).GetProperty("periodStart").GetString()));
        Assert.Equal(0, await App.WithDbAsync(db => db.UsageEvents.CountAsync(e => e.Late)));
    }

    [Fact]
    public async Task YearlyLeapDayAnchorCatchesUpOverSeveralYears()
    {
        var product = await Data.ProductAsync();
        await Data.PlanAsync(product, "yearly", [Items.Flat("Annual", 120_000)], interval: "year");
        Clock.Set(new DateTimeOffset(2028, 2, 29, 12, 0, 0, TimeSpan.Zero));
        var subscription = await Data.SubscribeAsync(await Data.CustomerAsync(), "yearly");

        Clock.Set(new DateTimeOffset(2032, 3, 1, 0, 0, 0, TimeSpan.Zero));
        for (var pass = 0; pass < 6; pass++)
        {
            await RunBillingAsync();
        }

        var starts = (await Data.InvoicesAsync(subscription)).Select(i => i.GetProperty("periodStart").GetString()).ToArray();
        Assert.Equal(new[] { "2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29" }, starts);
    }

    [Fact]
    public async Task BoundaryOnADayWithoutLocalMidnightUsesTheFirstValidInstant()
    {
        var product = await Data.ProductAsync();
        await Data.PlanAsync(product, "basic", [Items.Flat("Basic", 3000)]);
        Clock.Set(new DateTimeOffset(2026, 8, 6, 16, 0, 0, TimeSpan.Zero));

        var subscription = await Data.TrySubscribeAsync(await Data.CustomerAsync(timezone: "America/Santiago"), "basic");

        Assert.Equal("2026-09-06", subscription["currentPeriodEnd"].GetString());
        Assert.Equal("2026-09-06T05:00:00Z", subscription["nextBillingAt"].GetString());
    }

    [Fact]
    public async Task OutageDuringDunningResumesTheScheduleFromTheMissedAttempt()
    {
        var product = await Data.ProductAsync();
        await Data.PlanAsync(product, "basic", [Items.Flat("Basic", 3000)]);
        var subscription = await Data.SubscribeAsync(await Data.CustomerAsync(token: "tok_decline_card_declined"), "basic");
        await App.RunLoopAsync<PaymentRun>();

        Clock.Advance(TimeSpan.FromDays(20));
        await App.RunLoopAsync<PaymentRun>();
        await App.RunLoopAsync<PaymentRun>();

        var invoice = (await Data.InvoicesAsync(subscription))[0];
        Assert.Equal(2, invoice.GetProperty("declineCount").GetInt32());
        Assert.Equal(Clock.GetUtcNow().AddDays(5), invoice.GetProperty("nextPaymentAttemptAt").GetDateTimeOffset());
    }

    private static JsonElement UsageLine(JsonElement invoice) =>
        invoice.GetProperty("lines").EnumerateArray().Single(l => l.GetProperty("kind").GetString() == "usage");
}
