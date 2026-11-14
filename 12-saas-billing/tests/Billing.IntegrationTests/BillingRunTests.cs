using Billing.Core.Data;
using Billing.Core.Services;
using Billing.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Billing.IntegrationTests;

public sealed class BillingRunTests(BillingApp app) : IntegrationTest(app)
{
    private async Task CatalogAsync(int trialDays = 0)
    {
        var product = await Data.ProductAsync();
        await Data.PlanAsync(product, "basic", [Items.Flat("Basic", 3000), Items.Seats("Seats", 1000)], trialDays: trialDays);
    }

    private Task RunBillingAsync() => App.RunLoopAsync<BillingRun>();

    [Fact]
    public async Task TrialEndActivatesTheSubscriptionAndBillsPeriodZero()
    {
        await CatalogAsync(trialDays: 14);
        var customer = await Data.CustomerAsync();
        var id = await Data.SubscribeAsync(customer, "basic");

        Clock.Set(new DateTimeOffset(2026, 1, 28, 23, 59, 59, TimeSpan.Zero));
        await RunBillingAsync();
        Assert.Empty(await Data.InvoicesAsync(id));

        Clock.Set(new DateTimeOffset(2026, 1, 29, 0, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();

        var subscription = await Data.SubscriptionAsync(id);
        Assert.Equal("active", subscription.GetProperty("status").GetString());
        Assert.Equal("2026-01-29", subscription.GetProperty("currentPeriodStart").GetString());
        Assert.Equal("2026-02-28", subscription.GetProperty("currentPeriodEnd").GetString());
        var invoice = Assert.Single(await Data.InvoicesAsync(id));
        Assert.Equal("2026-01-29", invoice.GetProperty("periodStart").GetString());
        Assert.Equal(4000, invoice.GetProperty("totalMinor").GetInt64());

        var types = await App.WithDbAsync(db => db.WebhookEvents.OrderBy(e => e.Sequence).Select(e => e.Type).ToListAsync());
        Assert.Contains("subscription.trial_ended", types);
    }

    [Fact]
    public async Task BoundaryInvoiceChargesTheNextPeriodInAdvance()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();
        var id = await Data.SubscribeAsync(customer, "basic", quantity: 2);

        Clock.Set(new DateTimeOffset(2026, 2, 15, 1, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();

        var invoices = await Data.InvoicesAsync(id);
        Assert.Equal(2, invoices.Count);
        var boundary = invoices[1];
        Assert.Equal("cycle", boundary.GetProperty("kind").GetString());
        Assert.Equal("2026-02-15", boundary.GetProperty("periodStart").GetString());
        Assert.Equal("2026-03-15", boundary.GetProperty("periodEnd").GetString());
        Assert.Equal(5000, boundary.GetProperty("totalMinor").GetInt64());
        Assert.All(boundary.GetProperty("lines").EnumerateArray(), l => Assert.Equal("2026-02-15", l.GetProperty("periodStart").GetString()));

        var subscription = await Data.SubscriptionAsync(id);
        Assert.Equal(1, subscription.GetProperty("periodIndex").GetInt32());
        Assert.Equal("2026-03-15T01:00:00Z", subscription.GetProperty("nextBillingAt").GetString());
    }

    [Fact]
    public async Task NothingIsBilledBeforeTheGraceWindowEnds()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();
        var id = await Data.SubscribeAsync(customer, "basic");

        Clock.Set(new DateTimeOffset(2026, 2, 15, 0, 59, 59, TimeSpan.Zero));
        await RunBillingAsync();
        Assert.Single(await Data.InvoicesAsync(id));

        Clock.Set(new DateTimeOffset(2026, 2, 15, 1, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();
        Assert.Equal(2, (await Data.InvoicesAsync(id)).Count);
    }

    [Fact]
    public async Task WorkerDownForThreeMonthsCatchesUpOnePeriodPerPass()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();
        var id = await Data.SubscribeAsync(customer, "basic");

        Clock.Set(new DateTimeOffset(2026, 4, 20, 0, 0, 0, TimeSpan.Zero));
        for (var pass = 0; pass < 5; pass++)
        {
            await RunBillingAsync();
        }

        var starts = (await Data.InvoicesAsync(id)).Select(i => i.GetProperty("periodStart").GetString()).ToArray();
        Assert.Equal(new[] { "2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15" }, starts);
        var subscription = await Data.SubscriptionAsync(id);
        Assert.Equal(3, subscription.GetProperty("periodIndex").GetInt32());
        Assert.Equal("2026-05-15T01:00:00Z", subscription.GetProperty("nextBillingAt").GetString());
    }

    [Fact]
    public async Task MonthEndAnchorFollowsShortMonths()
    {
        await CatalogAsync();
        Clock.Set(new DateTimeOffset(2026, 1, 31, 12, 0, 0, TimeSpan.Zero));
        var customer = await Data.CustomerAsync();
        var id = await Data.SubscribeAsync(customer, "basic");

        Clock.Set(new DateTimeOffset(2026, 4, 30, 2, 0, 0, TimeSpan.Zero));
        for (var pass = 0; pass < 4; pass++)
        {
            await RunBillingAsync();
        }

        var starts = (await Data.InvoicesAsync(id)).Select(i => i.GetProperty("periodStart").GetString()).ToArray();
        Assert.Equal(new[] { "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30" }, starts);
    }

    [Fact]
    public async Task BoundaryInAucklandFallsAtLocalMidnight()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync(timezone: "Pacific/Auckland");

        var subscription = await Data.TrySubscribeAsync(customer, "basic");

        Assert.Equal("2026-01-16", subscription["currentPeriodStart"].GetString());
        Assert.Equal("2026-02-15T12:00:00Z", subscription["nextBillingAt"].GetString());
    }

    [Fact]
    public async Task ConcurrentRunsProduceOneInvoicePerPeriod()
    {
        await CatalogAsync();
        var subscriptions = new List<Guid>();
        for (var i = 0; i < 5; i++)
        {
            var customer = await Data.CustomerAsync();
            subscriptions.Add(await Data.SubscribeAsync(customer, "basic"));
        }

        Clock.Set(new DateTimeOffset(2026, 2, 15, 1, 0, 0, TimeSpan.Zero));
        await Task.WhenAll(RunBillingAsync(), RunBillingAsync(), RunBillingAsync());

        foreach (var id in subscriptions)
        {
            var invoices = await Data.InvoicesAsync(id);
            Assert.Equal(new[] { "2026-01-15", "2026-02-15" }, invoices.Select(i => i.GetProperty("periodStart").GetString()).ToArray());
        }

        var cycleInvoices = await App.WithDbAsync(db => db.Invoices.CountAsync(i => i.Kind == InvoiceKind.Cycle));
        Assert.Equal(10, cycleInvoices);
    }

    [Fact]
    public async Task PastDueSubscriptionsKeepBeingBilled()
    {
        await CatalogAsync();
        var customer = await Data.CustomerAsync();
        var id = await Data.SubscribeAsync(customer, "basic");
        await App.WithDbAsync(db => db.Subscriptions.Where(s => s.Id == id)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.Status, SubscriptionStatus.PastDue)));

        Clock.Set(new DateTimeOffset(2026, 2, 15, 1, 0, 0, TimeSpan.Zero));
        await RunBillingAsync();

        Assert.Equal(2, (await Data.InvoicesAsync(id)).Count);
    }
}
