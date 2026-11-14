using System.Net;
using System.Text;
using System.Text.Json;
using Billing.Core.Data;
using Billing.Core.Services;
using Billing.Core.Webhooks;
using Billing.Domain;
using Billing.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Billing.IntegrationTests;

public sealed class WebhookTests(BillingApp app) : IntegrationTest(app)
{
    private ApiClient? _ops;

    private async Task<ApiClient> OpsAsync() => _ops ??= await App.ClientAsync(ApiRole.BillingOps);

    private async Task<(Guid Id, string Secret)> EndpointAsync(string url, params string[] eventTypes)
    {
        var response = await (await Data.AdminAsync()).PostAsync("/v1/webhook-endpoints", new { url, eventTypes });
        TestData.Ensure(response, 201);
        return (response.Id, response["secret"].GetString()!);
    }

    /// <summary>Creates and finalises a manual invoice; with enough credit it is paid at once.</summary>
    private async Task<Guid> FinalizedInvoiceAsync(Guid customer)
    {
        var ops = await OpsAsync();
        var draft = await ops.PostAsync("/v1/invoices", new { customerId = customer, lines = new[] { new { description = "Work", quantity = 1, unitAmountMinor = 1000 } } });
        TestData.Ensure(draft, 201);
        TestData.Ensure(await ops.PostAsync($"/v1/invoices/{draft.Id}/finalize"), 200);
        return draft.Id;
    }

    private async Task<Guid> CustomerWithCreditAsync(long credit)
    {
        var customer = await Data.CustomerAsync(token: null);
        TestData.Ensure(
            await (await OpsAsync()).PostAsync($"/v1/customers/{customer}/credit-adjustments", new { amountMinor = credit, reason = "Prepaid" }, $"grant-{customer:N}"),
            201);
        return customer;
    }

    private Task FanOutAsync() => App.RunLoopAsync<WebhookFanOut>();

    private Task DeliverAsync() => App.RunLoopAsync<WebhookDispatcher>();

    private async Task<IReadOnlyList<WebhookDelivery>> DeliveriesAsync() =>
        await App.WithDbAsync(db => db.WebhookDeliveries.AsNoTracking().OrderBy(d => d.Sequence).ToListAsync());

    private static string EventType(RecordedRequest request) => request.Header("Billing-Event-Type");

    [Fact]
    public async Task EventIsWrittenWithItsChangeAndNotWhenTheChangeRollsBack()
    {
        var customer = await Data.CustomerAsync();
        var ops = await OpsAsync();
        var draft = await ops.PostAsync("/v1/invoices", new { customerId = customer, lines = new[] { new { description = "Work", quantity = 1, unitAmountMinor = 1000 } } });

        await using (var scope = App.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            await using var transaction = await db.Database.BeginTransactionAsync();
            await scope.ServiceProvider.GetRequiredService<InvoiceService>().FinalizeAsync(draft.Id, default);
            Assert.Equal(1, await db.WebhookEvents.CountAsync());
            await transaction.RollbackAsync();
        }

        Assert.Equal(0, await App.WithDbAsync(db => db.WebhookEvents.CountAsync()));

        await ops.PostAsync($"/v1/invoices/{draft.Id}/finalize");
        var stored = await App.WithDbAsync(db => db.WebhookEvents.SingleAsync());
        Assert.Equal("invoice.finalized", stored.Type);
        Assert.Equal(draft.Id, stored.ObjectId);
        Assert.Null(stored.FannedOutAt);
    }

    [Fact]
    public async Task FanOutHonoursEventTypesStatusAndEndpointCreationTime()
    {
        var (invoicesOnly, _) = await EndpointAsync("https://hooks.test/invoices", "invoice.finalized");
        var (everything, _) = await EndpointAsync("https://hooks.test/all", "*");
        var (subscriptionsOnly, _) = await EndpointAsync("https://hooks.test/subs", "subscription.created");
        var (disabled, _) = await EndpointAsync("https://hooks.test/off", "*");
        TestData.Ensure(await (await Data.AdminAsync()).PatchAsync($"/v1/webhook-endpoints/{disabled}", new { status = "disabled" }), 200);

        var customer = await Data.CustomerAsync();
        await FinalizedInvoiceAsync(customer);
        Clock.Advance(TimeSpan.FromSeconds(1));
        var (late, _) = await EndpointAsync("https://hooks.test/late", "*");
        await FanOutAsync();

        var endpoints = (await DeliveriesAsync()).Select(d => d.EndpointId).ToHashSet();
        Assert.Equal(new HashSet<Guid> { invoicesOnly, everything }, endpoints);
        Assert.DoesNotContain(subscriptionsOnly, endpoints);
        Assert.DoesNotContain(late, endpoints);
        Assert.NotNull((await App.WithDbAsync(db => db.WebhookEvents.SingleAsync())).FannedOutAt);
    }

    [Fact]
    public async Task DeliveryPostsTheStoredBytesWithAVerifiableSignature()
    {
        var (_, secret) = await EndpointAsync("https://hooks.test/a", "*");
        var invoiceId = await FinalizedInvoiceAsync(await Data.CustomerAsync());
        await FanOutAsync();

        await DeliverAsync();

        var request = Assert.Single(App.Webhooks.Requests);
        var stored = await App.WithDbAsync(db => db.WebhookEvents.SingleAsync());
        Assert.Equal(Encoding.UTF8.GetBytes(stored.Body), request.Body);
        Assert.Equal("application/json", request.ContentType);
        Assert.Equal(stored.Id.ToString(), request.Header("Billing-Event-Id"));
        Assert.Equal("invoice.finalized", EventType(request));
        Assert.Equal("1", request.Header("Billing-Delivery-Attempt"));
        Assert.True(WebhookSignature.Verify(request.Header("Billing-Signature"), request.Body, secret, Clock.GetUtcNow().ToUnixTimeSeconds(), TimeSpan.FromMinutes(5)));

        using var envelope = JsonDocument.Parse(request.Body);
        var root = envelope.RootElement;
        Assert.Equal(stored.Id, root.GetProperty("id").GetGuid());
        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal("invoice", root.GetProperty("aggregateType").GetString());
        Assert.Equal(invoiceId, root.GetProperty("aggregateId").GetGuid());
        Assert.Equal(stored.Sequence, root.GetProperty("sequence").GetInt64());
        Assert.False(string.IsNullOrEmpty(root.GetProperty("requestId").GetString()));
        Assert.Equal("open", root.GetProperty("data").GetProperty("object").GetProperty("status").GetString());
        Assert.Equal(WebhookDeliveryStatus.Succeeded, (await DeliveriesAsync())[0].Status);
    }

    [Fact]
    public async Task RotatedSecretSignsAlongsideTheOldOneFor24Hours()
    {
        var (endpoint, oldSecret) = await EndpointAsync("https://hooks.test/a", "*");
        var rotated = await (await Data.AdminAsync()).PostAsync($"/v1/webhook-endpoints/{endpoint}/rotate-secret");
        var newSecret = rotated["secret"].GetString()!;
        var customer = await Data.CustomerAsync();

        await FinalizedInvoiceAsync(customer);
        await FanOutAsync();
        await DeliverAsync();
        var during = App.Webhooks.Requests[0];
        var now = Clock.GetUtcNow().ToUnixTimeSeconds();
        Assert.True(WebhookSignature.Verify(during.Header("Billing-Signature"), during.Body, newSecret, now, TimeSpan.FromMinutes(5)));
        Assert.True(WebhookSignature.Verify(during.Header("Billing-Signature"), during.Body, oldSecret, now, TimeSpan.FromMinutes(5)));

        Clock.Advance(TimeSpan.FromHours(24));
        await FinalizedInvoiceAsync(customer);
        await FanOutAsync();
        await DeliverAsync();
        var after = App.Webhooks.Requests[1];
        now = Clock.GetUtcNow().ToUnixTimeSeconds();
        Assert.True(WebhookSignature.Verify(after.Header("Billing-Signature"), after.Body, newSecret, now, TimeSpan.FromMinutes(5)));
        Assert.False(WebhookSignature.Verify(after.Header("Billing-Signature"), after.Body, oldSecret, now, TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public async Task FailedDeliveriesFollowTheRetryScheduleUntilTheEighthFailure()
    {
        await EndpointAsync("https://hooks.test/a", "*");
        App.Webhooks.Respond = _ => HttpStatusCode.InternalServerError;
        await FinalizedInvoiceAsync(await Data.CustomerAsync());
        await FanOutAsync();

        TimeSpan[] expected = [TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(30), TimeSpan.FromHours(2), TimeSpan.FromHours(6), TimeSpan.FromHours(12), TimeSpan.FromHours(24)];
        foreach (var delay in expected)
        {
            var before = Clock.GetUtcNow();
            await DeliverAsync();
            var delivery = (await DeliveriesAsync())[0];
            Assert.Equal(WebhookDeliveryStatus.Pending, delivery.Status);
            Assert.Equal(before + delay, delivery.NextAttemptAt);
            Clock.Set(delivery.NextAttemptAt);
        }

        await DeliverAsync();

        var failed = (await DeliveriesAsync())[0];
        Assert.Equal(WebhookDeliveryStatus.Failed, failed.Status);
        Assert.Equal(8, failed.Attempts);
        Assert.Equal(500, failed.LastStatusCode);
        Assert.Equal(Enumerable.Range(1, 8).Select(i => i.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray(), App.Webhooks.Requests.Select(r => r.Header("Billing-Delivery-Attempt")).ToArray());
    }

    [Fact]
    public async Task EventsOfOneObjectArriveInOrderAndOtherObjectsAreNotHeldUp()
    {
        await EndpointAsync("https://hooks.test/a", "*");
        var paidAtOnce = await FinalizedInvoiceAsync(await CustomerWithCreditAsync(5000));
        var other = await FinalizedInvoiceAsync(await Data.CustomerAsync());
        await FanOutAsync();
        var failFirst = true;
        App.Webhooks.Respond = request =>
        {
            if (failFirst && EventType(request) == "invoice.finalized")
            {
                failFirst = false;
                return HttpStatusCode.ServiceUnavailable;
            }

            return HttpStatusCode.OK;
        };

        await DeliverAsync();
        var firstPass = App.Webhooks.Requests.Select(r => r.Header("Billing-Event-Type")).ToList();
        Assert.Equal(new[] { "invoice.finalized", "invoice.finalized" }, firstPass.ToArray());
        var deliveries = await DeliveriesAsync();
        Assert.Equal(WebhookDeliveryStatus.Pending, deliveries.Single(d => d.ObjectId == paidAtOnce && d.Attempts == 1).Status);
        Assert.Equal(WebhookDeliveryStatus.Succeeded, deliveries.Single(d => d.ObjectId == other).Status);

        Clock.Advance(TimeSpan.FromMinutes(1));
        await DeliverAsync();
        await DeliverAsync();

        var forPaidInvoice = App.Webhooks.Requests
            .Where(r => JsonDocument.Parse(r.Body).RootElement.GetProperty("aggregateId").GetGuid() == paidAtOnce)
            .Select(r => r.Header("Billing-Event-Type"))
            .ToArray();
        Assert.Equal(new[] { "invoice.finalized", "invoice.finalized", "invoice.paid" }, forPaidInvoice);
        Assert.All(await DeliveriesAsync(), d => Assert.Equal(WebhookDeliveryStatus.Succeeded, d.Status));
    }

    [Fact]
    public async Task FailedDeliveryNoLongerHoldsBackTheObjectAndCanBeRetriedByHand()
    {
        await EndpointAsync("https://hooks.test/a", "*");
        var invoiceId = await FinalizedInvoiceAsync(await CustomerWithCreditAsync(5000));
        await FanOutAsync();
        App.Webhooks.Respond = request => EventType(request) == "invoice.finalized" ? HttpStatusCode.BadGateway : HttpStatusCode.OK;
        var firstDelivery = (await DeliveriesAsync())[0].Id;
        await App.WithDbAsync(db => db.WebhookDeliveries
            .Where(d => d.Id == firstDelivery)
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.Attempts, 7)));

        await DeliverAsync();
        await DeliverAsync();

        var deliveries = await DeliveriesAsync();
        Assert.Equal(WebhookDeliveryStatus.Failed, deliveries[0].Status);
        Assert.Equal(WebhookDeliveryStatus.Succeeded, deliveries[1].Status);
        Assert.Equal("invoice.paid", EventType(App.Webhooks.Requests[^1]));

        App.Webhooks.Respond = _ => HttpStatusCode.OK;
        var retried = await (await OpsAsync()).PostAsync($"/v1/webhook-deliveries/{deliveries[0].Id}/retry");
        Assert.Equal("pending", retried["status"].GetString());
        Assert.Equal(0, retried["attempts"].GetInt32());
        await DeliverAsync();

        Assert.Equal(WebhookDeliveryStatus.Succeeded, (await DeliveriesAsync())[0].Status);
        Assert.Equal(invoiceId, JsonDocument.Parse(App.Webhooks.Requests[^1].Body).RootElement.GetProperty("aggregateId").GetGuid());
        Assert.Equal("1", App.Webhooks.Requests[^1].Header("Billing-Delivery-Attempt"));
    }

    [Fact]
    public async Task EndpointAnsweringGoneIsDisabledAndReceivesNothingFurther()
    {
        var (endpoint, _) = await EndpointAsync("https://hooks.test/gone", "*");
        await FinalizedInvoiceAsync(await CustomerWithCreditAsync(5000));
        await FinalizedInvoiceAsync(await Data.CustomerAsync());
        await FanOutAsync();
        App.Webhooks.Respond = _ => HttpStatusCode.Gone;

        await DeliverAsync();
        var sentBefore = App.Webhooks.Requests.Count;
        await FinalizedInvoiceAsync(await Data.CustomerAsync());
        await FanOutAsync();
        await DeliverAsync();

        Assert.Equal(sentBefore, App.Webhooks.Requests.Count);
        Assert.All(await DeliveriesAsync(), d => Assert.Equal(WebhookDeliveryStatus.Failed, d.Status));
        var endpoints = await (await OpsAsync()).GetAsync("/v1/webhook-endpoints");
        Assert.Equal("disabled", endpoints["data"].EnumerateArray().Single(e => e.GetProperty("id").GetGuid() == endpoint).GetProperty("status").GetString());
    }

    [Fact]
    public async Task CrashAfterSendingLeadsToASecondDeliveryOfTheSameEventId()
    {
        await EndpointAsync("https://hooks.test/a", "*");
        await FinalizedInvoiceAsync(await Data.CustomerAsync());
        await FanOutAsync();

        await using (var scope = App.Scope())
        {
            var dispatcher = scope.ServiceProvider.GetRequiredService<WebhookDispatcher>();
            var claimed = await dispatcher.ClaimDueAsync(Clock.GetUtcNow(), default);
            await dispatcher.SendAsync(Assert.Single(claimed), default);
        }

        await DeliverAsync();
        Assert.Single(App.Webhooks.Requests);

        Clock.Advance(TimeSpan.FromMinutes(5));
        await DeliverAsync();

        Assert.Equal(2, App.Webhooks.Requests.Count);
        Assert.Equal(App.Webhooks.Requests[0].Header("Billing-Event-Id"), App.Webhooks.Requests[1].Header("Billing-Event-Id"));
        Assert.Equal(WebhookDeliveryStatus.Succeeded, (await DeliveriesAsync())[0].Status);
    }

    [Fact]
    public async Task PlainHttpEndpointsAreRefusedByDefault()
    {
        var response = await (await Data.AdminAsync()).PostAsync("/v1/webhook-endpoints", new { url = "http://hooks.test/a", eventTypes = new[] { "*" } });
        var unknownType = await (await Data.AdminAsync()).PostAsync("/v1/webhook-endpoints", new { url = "https://hooks.test/a", eventTypes = new[] { "invoice.exploded" } });

        Assert.Equal(400, response.Status);
        Assert.Equal(400, unknownType.Status);
    }

    [Fact]
    public async Task PurgeRemovesOldIdempotencyRecordsAndDeliveredWebhooks()
    {
        await EndpointAsync("https://hooks.test/a", "*");
        await FinalizedInvoiceAsync(await CustomerWithCreditAsync(5000));
        await FanOutAsync();
        await DeliverAsync();
        Assert.Equal(1, await App.WithDbAsync(db => db.IdempotencyRecords.CountAsync()));

        Clock.Advance(TimeSpan.FromDays(8));
        await App.RunLoopAsync<PurgeRun>();
        Assert.Equal(0, await App.WithDbAsync(db => db.IdempotencyRecords.CountAsync()));
        Assert.Equal(2, await App.WithDbAsync(db => db.WebhookDeliveries.CountAsync()));

        Clock.Advance(TimeSpan.FromDays(23));
        await App.RunLoopAsync<PurgeRun>();
        Assert.Equal(0, await App.WithDbAsync(db => db.WebhookDeliveries.CountAsync()));
    }
}
