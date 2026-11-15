using System.Text.Json;
using Billing.Core.Data;
using Billing.Core.Services;
using Billing.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Billing.IntegrationTests;

[Collection(DatabaseCollection.Name)]
public sealed class UsageTests(BillingApp app) : IntegrationTest(app)
{
    private static readonly DateTimeOffset Boundary = new(2026, 2, 15, 1, 0, 0, TimeSpan.Zero);

    private async Task CatalogAsync(int trialDays = 0)
    {
        var product = await Data.ProductAsync();
        await Data.MeterAsync("api_calls");
        await Data.MeterAsync("peak_seats", "max");
        await Data.MeterAsync("storage");
        await Data.PlanAsync(
            product,
            "metered",
            [
                Items.Flat("Platform", 1000),
                Items.Usage("api_calls", "graduated", (1_000, 0, 0), (10_000, 2, 0), (null, 1, 0)),
                Items.PerUnit("peak_seats", 100),
            ],
            trialDays: trialDays);
    }

    private static object Event(string key, Guid subscriptionId, string meter, long quantity, DateTimeOffset at) =>
        new { eventKey = key, subscriptionId, meterCode = meter, quantity, occurredAt = at };

    private async Task<IReadOnlyList<(string Status, string? Reason)>> SendAsync(params object[] events)
    {
        var response = await (await Data.ServiceAsync()).PostAsync("/v1/usage-events", new { events });
        TestData.Ensure(response, 200);
        return response["results"].EnumerateArray()
            .Select(r => (r.GetProperty("status").GetString()!, r.GetProperty("reason").ValueKind == JsonValueKind.Null ? null : r.GetProperty("reason").GetString()))
            .ToList();
    }

    private Task RunBillingAsync() => App.RunLoopAsync<BillingRun>();

    [Fact]
    public async Task BatchResultsFollowRequestOrderAndRejectionsDoNotFailTheBatch()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");
        Clock.Set(new DateTimeOffset(2026, 1, 20, 12, 0, 0, TimeSpan.Zero));
        var now = Clock.GetUtcNow();

        var results = await SendAsync(
            Event("a", sub, "api_calls", 10, now),
            Event("b", Guid.NewGuid(), "api_calls", 10, now),
            Event("c", sub, "storage", 10, now),
            Event("d", sub, "nonexistent", 10, now),
            Event("e", sub, "api_calls", 10, now.AddMinutes(6)),
            Event("f", sub, "api_calls", 10, now.AddMinutes(5)),
            Event("g", sub, "api_calls", 10, now.AddDays(-36)),
            Event("h", sub, "api_calls", 10, new DateTimeOffset(2026, 1, 14, 23, 0, 0, TimeSpan.Zero)));

        Assert.Equal(
            new (string, string?)[]
            {
                ("accepted", null),
                ("rejected", "unknown_subscription"),
                ("rejected", "unknown_meter"),
                ("rejected", "unknown_meter"),
                ("rejected", "in_future"),
                ("accepted", null),
                ("rejected", "too_old"),
                ("rejected", "before_billing_start"),
            },
            results.ToArray());
        Assert.Equal(2, await App.WithDbAsync(db => db.UsageEvents.CountAsync()));
    }

    [Fact]
    public async Task SameKeyIsStoredOnceAndAConflictingResendIsRejected()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");
        var at = Clock.GetUtcNow();

        var first = await SendAsync(Event("k1", sub, "api_calls", 10, at), Event("k1", sub, "api_calls", 10, at), Event("k1", sub, "api_calls", 11, at));
        var second = await SendAsync(Event("k1", sub, "api_calls", 10, at), Event("k1", sub, "api_calls", 99, at));

        Assert.Equal(new (string, string?)[] { ("accepted", null), ("duplicate", null), ("rejected", "key_conflict") }, first.ToArray());
        Assert.Equal(new (string, string?)[] { ("duplicate", null), ("rejected", "key_conflict") }, second.ToArray());
        var stored = await App.WithDbAsync(db => db.UsageEvents.SingleAsync());
        Assert.Equal(10, stored.Quantity);
    }

    [Fact]
    public async Task ConcurrentBatchesWithTheSameKeyStoreItOnce()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");
        var at = Clock.GetUtcNow();

        var results = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => SendAsync(Event("shared", sub, "api_calls", 10, at))));

        Assert.Single(results, r => r[0].Status == "accepted");
        Assert.Equal(5, results.Count(r => r[0].Status == "duplicate"));
        Assert.Equal(1, await App.WithDbAsync(db => db.UsageEvents.CountAsync()));
    }

    [Fact]
    public async Task FullBatchIsStoredWithOneResultPerEvent()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");
        var at = Clock.GetUtcNow();

        var results = await SendAsync(Enumerable.Range(0, 500).Select(i => Event($"bulk-{i}", sub, "api_calls", 1, at)).ToArray());

        Assert.Equal(500, results.Count);
        Assert.All(results, r => Assert.Equal(("accepted", (string?)null), r));
        Assert.Equal(500, await App.WithDbAsync(db => db.UsageEvents.CountAsync()));
    }

    [Fact]
    public async Task UsageDuringTheTrialIsRejected()
    {
        await CatalogAsync(trialDays: 14);
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");

        var results = await SendAsync(Event("t1", sub, "api_calls", 10, Clock.GetUtcNow()));

        Assert.Equal(("rejected", "before_billing_start"), results[0]);
    }

    [Fact]
    public async Task MalformedBatchStoresNothing()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");
        var service = await Data.ServiceAsync();

        var response = await service.PostAsync(
            "/v1/usage-events",
            new { events = new object[] { Event("ok", sub, "api_calls", 1, Clock.GetUtcNow()), new { eventKey = "bad", subscriptionId = sub, meterCode = "api_calls" } } });
        var tooMany = await service.PostAsync(
            "/v1/usage-events",
            new { events = Enumerable.Range(0, 501).Select(i => Event($"e{i}", sub, "api_calls", 1, Clock.GetUtcNow())).ToArray() });

        Assert.Equal(400, response.Status);
        Assert.Equal(400, tooMany.Status);
        Assert.Equal(0, await App.WithDbAsync(db => db.UsageEvents.CountAsync()));
    }

    [Fact]
    public async Task BoundaryInvoiceRatesSumAndMaxMetersBeforeTheAdvanceCharge()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");
        Clock.Set(new DateTimeOffset(2026, 2, 1, 0, 0, 0, TimeSpan.Zero));
        var at = Clock.GetUtcNow();
        await SendAsync(
            Event("c1", sub, "api_calls", 5_000, at),
            Event("c2", sub, "api_calls", 4_000, at),
            Event("c3", sub, "api_calls", 3_500, at),
            Event("p1", sub, "peak_seats", 5, at),
            Event("p2", sub, "peak_seats", 12, at),
            Event("p3", sub, "peak_seats", 7, at));

        Clock.Set(Boundary);
        await RunBillingAsync();

        var invoice = (await Data.InvoicesAsync(sub))[1];
        var lines = invoice.GetProperty("lines").EnumerateArray().ToList();
        Assert.Equal(new[] { "usage", "usage", "flat" }, lines.Select(l => l.GetProperty("kind").GetString()).ToArray());
        Assert.Equal(12_500, lines[0].GetProperty("quantity").GetInt64());
        Assert.Equal(20_500, lines[0].GetProperty("amountMinor").GetInt64());
        Assert.Equal("2026-01-15", lines[0].GetProperty("periodStart").GetString());
        Assert.Equal(12, lines[1].GetProperty("quantity").GetInt64());
        Assert.Equal(1_200, lines[1].GetProperty("amountMinor").GetInt64());
        Assert.Equal("2026-02-15", lines[2].GetProperty("periodStart").GetString());
        Assert.Equal(20_500 + 1_200 + 1_000, invoice.GetProperty("totalMinor").GetInt64());
    }

    [Fact]
    public async Task PeriodWithoutUsageHasNoUsageLine()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");

        Clock.Set(Boundary);
        await RunBillingAsync();

        var invoice = (await Data.InvoicesAsync(sub))[1];
        Assert.Equal(new[] { "flat" }, invoice.GetProperty("lines").EnumerateArray().Select(l => l.GetProperty("kind").GetString()).ToArray());
    }

    [Fact]
    public async Task EventArrivingDuringTheGraceWindowIsOnTheEndedPeriodsInvoice()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");

        Clock.Set(new DateTimeOffset(2026, 2, 15, 0, 30, 0, TimeSpan.Zero));
        await SendAsync(Event("grace", sub, "peak_seats", 3, new DateTimeOffset(2026, 2, 14, 23, 59, 59, TimeSpan.Zero)));
        Clock.Set(Boundary);
        await RunBillingAsync();

        var line = (await Data.InvoicesAsync(sub))[1].GetProperty("lines")[0];
        Assert.Equal("usage", line.GetProperty("kind").GetString());
        Assert.Equal(300, line.GetProperty("amountMinor").GetInt64());
    }

    [Fact]
    public async Task EventArrivingAfterSealingIsBilledLateWithTheNextPeriod()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");
        Clock.Set(Boundary);
        await RunBillingAsync();
        var sealedInvoice = (await Data.InvoicesAsync(sub))[1];

        Clock.Set(Boundary.AddHours(1));
        var results = await SendAsync(Event("late", sub, "peak_seats", 4, new DateTimeOffset(2026, 2, 14, 23, 0, 0, TimeSpan.Zero)));
        Assert.Equal(("accepted", null), results[0]);

        var unchanged = (await Data.InvoicesAsync(sub))[1];
        Assert.Equal(sealedInvoice.GetProperty("totalMinor").GetInt64(), unchanged.GetProperty("totalMinor").GetInt64());

        Clock.Set(new DateTimeOffset(2026, 3, 15, 1, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();

        var next = (await Data.InvoicesAsync(sub))[2];
        var usageLine = next.GetProperty("lines")[0];
        Assert.Equal(400, usageLine.GetProperty("amountMinor").GetInt64());
        Assert.Equal("2026-02-15", usageLine.GetProperty("periodStart").GetString());
        var stored = await App.WithDbAsync(db => db.UsageEvents.SingleAsync());
        Assert.True(stored.Late);
    }

    [Fact]
    public async Task AucklandEventsSplitAtLocalMidnight()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(timezone: "Pacific/Auckland"), "metered");

        Clock.Set(new DateTimeOffset(2026, 2, 15, 11, 30, 0, TimeSpan.Zero));
        await SendAsync(
            Event("before", sub, "api_calls", 1, new DateTimeOffset(2026, 2, 15, 10, 59, 59, TimeSpan.Zero)),
            Event("after", sub, "api_calls", 1, new DateTimeOffset(2026, 2, 15, 11, 0, 0, TimeSpan.Zero)));
        Clock.Set(new DateTimeOffset(2026, 2, 15, 12, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();

        var support = await App.ClientAsync(ApiRole.Support);
        var ended = await support.GetAsync($"/v1/subscriptions/{sub}/usage?periodIndex=0");
        var current = await support.GetAsync($"/v1/subscriptions/{sub}/usage");

        Assert.Equal(1, ended["meters"][0].GetProperty("billedQuantity").GetInt64());
        Assert.Equal(1, current["periodIndex"].GetInt32());
        Assert.Equal(1, current["meters"][0].GetProperty("unbilledQuantity").GetInt64());
    }

    [Fact]
    public async Task UsageIngestedWhileSealingIsBilledExactlyOnce()
    {
        await CatalogAsync();
        var sub = await Data.SubscribeAsync(await Data.CustomerAsync(), "metered");
        Clock.Set(Boundary);
        var occurredAt = new DateTimeOffset(2026, 2, 14, 12, 0, 0, TimeSpan.Zero);

        var batches = Enumerable.Range(0, 20)
            .Select(i => SendAsync(Event($"race-{i}", sub, "peak_seats", 1, occurredAt), Event($"race-api-{i}", sub, "api_calls", 1, occurredAt)))
            .ToList();
        var billing = RunBillingAsync();
        await Task.WhenAll(batches.Cast<Task>().Append(billing));

        Clock.Set(new DateTimeOffset(2026, 3, 15, 1, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();

        var events = await App.WithDbAsync(db => db.UsageEvents.ToListAsync());
        Assert.Equal(40, events.Count);
        Assert.All(events, e => Assert.NotNull(e.BilledPeriodId));

        var apiCallsBilled = (await Data.InvoicesAsync(sub))
            .SelectMany(i => i.GetProperty("lines").EnumerateArray())
            .Where(l => l.GetProperty("kind").GetString() == "usage" && l.GetProperty("description").GetString() == "api_calls")
            .Sum(l => l.GetProperty("quantity").GetInt64());
        Assert.Equal(20, apiCallsBilled);
    }
}
