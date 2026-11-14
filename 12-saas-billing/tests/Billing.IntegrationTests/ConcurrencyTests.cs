using Billing.Core.Data;
using Billing.Core.Services;
using Billing.Core.Webhooks;
using Billing.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Billing.IntegrationTests;

public sealed class ConcurrencyTests(BillingApp app) : IntegrationTest(app)
{
    public override async Task InitializeAsync()
    {
        await base.InitializeAsync();
        var product = await Data.ProductAsync();
        await Data.PlanAsync(product, "basic", [Items.Flat("Basic", 3000)]);
    }

    [Fact]
    public async Task ConcurrentFinalizationsTakeConsecutiveNumbers()
    {
        var ops = await App.ClientAsync(ApiRole.BillingOps);
        var drafts = new List<Guid>();
        for (var i = 0; i < 12; i++)
        {
            var customer = await Data.CustomerAsync();
            var draft = await ops.PostAsync("/v1/invoices", new { customerId = customer, lines = new[] { new { description = "Work", quantity = 1, unitAmountMinor = 100 } } });
            drafts.Add(draft.Id);
        }

        var results = await Task.WhenAll(drafts.Select(id => ops.PostAsync($"/v1/invoices/{id}/finalize")));

        Assert.All(results, r => Assert.Equal(200, r.Status));
        var numbers = results.Select(r => r["number"].GetString()).Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(Enumerable.Range(1, 12).Select(n => $"INV-2026-{n:D6}").ToArray(), numbers);
    }

    [Fact]
    public async Task ConcurrentPaymentRunsChargeEachInvoiceOnce()
    {
        var invoices = new List<Guid>();
        for (var i = 0; i < 8; i++)
        {
            var subscription = await Data.SubscribeAsync(await Data.CustomerAsync(token: "tok_ok"), "basic");
            invoices.Add((await Data.InvoicesAsync(subscription))[0].GetProperty("id").GetGuid());
        }

        await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => App.RunLoopAsync<PaymentRun>()));

        Assert.Equal(8, App.Gateway.ChargeCalls.Count);
        Assert.Equal(8, App.Gateway.ChargeCalls.Distinct().Count());
        var attempts = await App.WithDbAsync(db => db.PaymentAttempts.ToListAsync());
        Assert.Equal(8, attempts.Count);
        Assert.All(attempts, a => Assert.Equal(PaymentAttemptStatus.Succeeded, a.Status));
        var paid = await App.WithDbAsync(db => db.Invoices.CountAsync(i => invoices.Contains(i.Id) && i.Status == InvoiceStatus.Paid));
        Assert.Equal(8, paid);
    }

    [Fact]
    public async Task ConcurrentWebhookWorkersDeliverEachEventOnceAndInOrder()
    {
        TestData.Ensure(await (await Data.AdminAsync()).PostAsync("/v1/webhook-endpoints", new { url = "https://hooks.test/a", eventTypes = new[] { "*" } }), 201);
        for (var i = 0; i < 5; i++)
        {
            await Data.SubscribeAsync(await Data.CustomerAsync(token: "tok_ok"), "basic");
        }

        await App.RunLoopAsync<PaymentRun>();

        await Task.WhenAll(App.RunLoopAsync<WebhookFanOut>(), App.RunLoopAsync<WebhookFanOut>(), App.RunLoopAsync<WebhookFanOut>());
        for (var pass = 0; pass < 4; pass++)
        {
            await Task.WhenAll(App.RunLoopAsync<WebhookDispatcher>(), App.RunLoopAsync<WebhookDispatcher>());
        }

        var eventCount = await App.WithDbAsync(db => db.WebhookEvents.CountAsync());
        var requests = App.Webhooks.Requests;
        Assert.Equal(eventCount, requests.Count);
        Assert.Equal(eventCount, requests.Select(r => r.Header("Billing-Event-Id")).Distinct().Count());

        var sequencesByObject = requests
            .Select(r => System.Text.Json.JsonDocument.Parse(r.Body).RootElement)
            .GroupBy(e => e.GetProperty("aggregateId").GetGuid())
            .Select(g => g.Select(e => e.GetProperty("sequence").GetInt64()).ToArray());
        Assert.All(sequencesByObject, sequences => Assert.Equal(sequences.Order().ToArray(), sequences));
    }

    [Fact]
    public async Task ConcurrentCancellationsOfOneSubscriptionSucceedOnce()
    {
        var subscription = await Data.SubscribeAsync(await Data.CustomerAsync(), "basic");
        var service = await Data.ServiceAsync();

        var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(i =>
            service.PostAsync($"/v1/subscriptions/{subscription}/cancel", new { mode = "immediate" }, $"cancel-race-{i}")));

        Assert.Single(results, r => r.Status == 200);
        Assert.Equal(3, results.Count(r => r.Status == 409));
        var canceledEvents = await App.WithDbAsync(db => db.WebhookEvents.CountAsync(e => e.Type == "subscription.canceled"));
        Assert.Equal(1, canceledEvents);
    }
}
