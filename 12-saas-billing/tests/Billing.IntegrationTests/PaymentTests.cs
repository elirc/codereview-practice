using System.Text.Json;
using Billing.Core.Data;
using Billing.Core.Services;
using Billing.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Billing.IntegrationTests;

[Collection(DatabaseCollection.Name)]
public sealed class PaymentTests(BillingApp app) : IntegrationTest(app)
{
    public override async Task InitializeAsync()
    {
        await base.InitializeAsync();
        var product = await Data.ProductAsync();
        await Data.PlanAsync(product, "basic", [Items.Flat("Basic", 3000)]);
        await Data.PlanAsync(product, "pro", [Items.Flat("Pro", 5000)]);
    }

    private Task CollectAsync() => App.RunLoopAsync<PaymentRun>();

    private async Task<(Guid Customer, Guid Subscription, Guid Invoice)> SubscribeAsync(string? token)
    {
        var customer = await Data.CustomerAsync(token: token);
        var subscription = await Data.SubscribeAsync(customer, "basic");
        var invoice = (await Data.InvoicesAsync(subscription))[0].GetProperty("id").GetGuid();
        return (customer, subscription, invoice);
    }

    private async Task<JsonElement> InvoiceAsync(Guid id) => (await (await Data.ServiceAsync()).GetAsync($"/v1/invoices/{id}")).Json;

    private async Task<string?> SubscriptionStatusAsync(Guid id) => (await Data.SubscriptionAsync(id)).GetProperty("status").GetString();

    private async Task SetTokenAsync(Guid customer, string token) =>
        TestData.Ensure(await (await Data.ServiceAsync()).PutAsync($"/v1/customers/{customer}/payment-method", new { token }), 200);

    [Fact]
    public async Task SuccessfulChargePaysTheInvoice()
    {
        var (_, _, invoiceId) = await SubscribeAsync("tok_ok");

        await CollectAsync();

        var invoice = await InvoiceAsync(invoiceId);
        Assert.Equal("paid", invoice.GetProperty("status").GetString());
        Assert.Equal(3000, invoice.GetProperty("amountPaidMinor").GetInt64());
        Assert.Equal(0, invoice.GetProperty("amountRemainingMinor").GetInt64());
        var attempt = Assert.Single(invoice.GetProperty("attempts").EnumerateArray());
        Assert.Equal("succeeded", attempt.GetProperty("status").GetString());
        Assert.Equal(1, App.Gateway.SuccessfulCharges);
        Assert.Equal(new[] { $"{invoiceId}:1" }, App.Gateway.ChargeCalls.ToArray());
    }

    [Fact]
    public async Task DeclinesFollowTheScheduleUntilTheInvoiceIsUncollectibleAndTheSubscriptionCanceled()
    {
        var (_, subscriptionId, invoiceId) = await SubscribeAsync("tok_decline_card_declined");
        var start = Clock.GetUtcNow();

        await CollectAsync();
        var first = await InvoiceAsync(invoiceId);
        Assert.Equal(1, first.GetProperty("declineCount").GetInt32());
        Assert.Equal(start.AddDays(3), first.GetProperty("nextPaymentAttemptAt").GetDateTimeOffset());
        Assert.Equal("past_due", await SubscriptionStatusAsync(subscriptionId));

        Clock.Set(start.AddDays(3));
        await CollectAsync();
        Assert.Equal(start.AddDays(8), (await InvoiceAsync(invoiceId)).GetProperty("nextPaymentAttemptAt").GetDateTimeOffset());

        Clock.Set(start.AddDays(8));
        await CollectAsync();
        Assert.Equal(start.AddDays(15), (await InvoiceAsync(invoiceId)).GetProperty("nextPaymentAttemptAt").GetDateTimeOffset());

        Clock.Set(start.AddDays(14));
        await CollectAsync();
        Assert.Equal(3, (await InvoiceAsync(invoiceId)).GetProperty("declineCount").GetInt32());

        Clock.Set(start.AddDays(15));
        await CollectAsync();

        var final = await InvoiceAsync(invoiceId);
        Assert.Equal("uncollectible", final.GetProperty("status").GetString());
        Assert.Equal(4, final.GetProperty("declineCount").GetInt32());
        Assert.Equal(JsonValueKind.Null, final.GetProperty("nextPaymentAttemptAt").ValueKind);
        var subscription = await Data.SubscriptionAsync(subscriptionId);
        Assert.Equal("canceled", subscription.GetProperty("status").GetString());
        Assert.Equal("dunning_exhausted", subscription.GetProperty("cancelReason").GetString());

        Clock.Set(start.AddDays(30));
        await CollectAsync();
        Assert.Equal(4, App.Gateway.ChargeCalls.Count);

        var types = await App.WithDbAsync(db => db.WebhookEvents.OrderBy(e => e.Sequence).Select(e => e.Type).ToListAsync());
        Assert.Equal(3, types.Count(t => t == "invoice.payment_failed"));
        Assert.Single(types, t => t == "invoice.marked_uncollectible");
        Assert.Single(types, t => t == "subscription.canceled");
    }

    [Fact]
    public async Task OpenInvoicesOfACanceledSubscriptionKeepBeingCollected()
    {
        var (customer, subscriptionId, invoiceId) = await SubscribeAsync("tok_decline_insufficient_funds");
        TestData.Ensure(
            await (await Data.ServiceAsync()).PostAsync($"/v1/subscriptions/{subscriptionId}/cancel", new { mode = "immediate" }, "cancel-key-1"),
            200);

        await CollectAsync();
        Assert.Equal(1, (await InvoiceAsync(invoiceId)).GetProperty("declineCount").GetInt32());
        Assert.Equal("canceled", await SubscriptionStatusAsync(subscriptionId));

        await SetTokenAsync(customer, "tok_ok");
        Clock.Advance(TimeSpan.FromDays(3));
        await CollectAsync();

        Assert.Equal("paid", (await InvoiceAsync(invoiceId)).GetProperty("status").GetString());
        Assert.Equal("canceled", await SubscriptionStatusAsync(subscriptionId));
    }

    [Fact]
    public async Task TimeoutLeavesTheAttemptUnknownAndALookupSettlesIt()
    {
        var (_, _, invoiceId) = await SubscribeAsync("tok_timeout_then_ok");

        await CollectAsync();
        var pending = await InvoiceAsync(invoiceId);
        Assert.Equal("unknown", pending.GetProperty("attempts")[0].GetProperty("status").GetString());
        Assert.Equal("open", pending.GetProperty("status").GetString());

        Clock.Advance(TimeSpan.FromMinutes(15));
        await CollectAsync();
        await CollectAsync();

        var invoice = await InvoiceAsync(invoiceId);
        Assert.Equal("paid", invoice.GetProperty("status").GetString());
        Assert.Equal(3000, invoice.GetProperty("amountPaidMinor").GetInt64());
        Assert.Single(invoice.GetProperty("attempts").EnumerateArray());
        Assert.Single(App.Gateway.ChargeCalls);
        Assert.Single(App.Gateway.LookupCalls);
        Assert.Equal(1, App.Gateway.SuccessfulCharges);
    }

    [Fact]
    public async Task LookupNotFoundDoesNotCountAsADeclineAndANewAttemptFollows()
    {
        var (customer, subscriptionId, invoiceId) = await SubscribeAsync("tok_timeout_unprocessed");
        await CollectAsync();
        Clock.Advance(TimeSpan.FromMinutes(15));
        await CollectAsync();

        var afterLookup = await InvoiceAsync(invoiceId);
        var attempt = afterLookup.GetProperty("attempts")[0];
        Assert.Equal("failed", attempt.GetProperty("status").GetString());
        Assert.Equal("not_processed", attempt.GetProperty("failureCode").GetString());
        Assert.False(attempt.GetProperty("countsAsDecline").GetBoolean());
        Assert.Equal(0, afterLookup.GetProperty("declineCount").GetInt32());
        Assert.Equal("active", await SubscriptionStatusAsync(subscriptionId));

        await SetTokenAsync(customer, "tok_ok");
        await CollectAsync();

        var invoice = await InvoiceAsync(invoiceId);
        Assert.Equal("paid", invoice.GetProperty("status").GetString());
        Assert.Equal(2, invoice.GetProperty("attempts").GetArrayLength());
        Assert.Equal(new[] { $"{invoiceId}:1", $"{invoiceId}:2" }, App.Gateway.ChargeCalls.ToArray());
    }

    [Fact]
    public async Task CrashAfterTheChargeDoesNotLeadToASecondCharge()
    {
        var (_, _, invoiceId) = await SubscribeAsync("tok_ok_then_crash");

        await CollectAsync();
        var afterCrash = await InvoiceAsync(invoiceId);
        Assert.Equal("pending", afterCrash.GetProperty("attempts")[0].GetProperty("status").GetString());

        await CollectAsync();
        Clock.Advance(TimeSpan.FromMinutes(15));
        await CollectAsync();

        Assert.Equal("paid", (await InvoiceAsync(invoiceId)).GetProperty("status").GetString());
        Assert.Single(App.Gateway.ChargeCalls);
        Assert.Equal(1, App.Gateway.SuccessfulCharges);
    }

    [Fact]
    public async Task CustomerWithoutAPaymentMethodCountsAsADeclineWithoutCallingTheGateway()
    {
        var (_, subscriptionId, invoiceId) = await SubscribeAsync(null);

        await CollectAsync();

        var invoice = await InvoiceAsync(invoiceId);
        var attempt = Assert.Single(invoice.GetProperty("attempts").EnumerateArray());
        Assert.Equal("no_payment_method", attempt.GetProperty("failureCode").GetString());
        Assert.True(attempt.GetProperty("countsAsDecline").GetBoolean());
        Assert.Equal(1, invoice.GetProperty("declineCount").GetInt32());
        Assert.Empty(App.Gateway.ChargeCalls);
        Assert.Equal("past_due", await SubscriptionStatusAsync(subscriptionId));
    }

    [Fact]
    public async Task PastDueReturnsToActiveOnlyWhenTheLastDeclinedInvoiceIsPaid()
    {
        var (customer, subscriptionId, cycleInvoice) = await SubscribeAsync("tok_decline_card_declined");
        Clock.Set(new DateTimeOffset(2026, 1, 20, 12, 0, 0, TimeSpan.Zero));
        TestData.Ensure(
            await (await Data.ServiceAsync()).PostAsync($"/v1/subscriptions/{subscriptionId}/change", new { planCode = "pro" }, "upgrade-key-1"),
            200);
        var prorationInvoice = (await Data.InvoicesAsync(subscriptionId))
            .Single(i => i.GetProperty("kind").GetString() == "proration")
            .GetProperty("id")
            .GetGuid();

        await CollectAsync();
        Assert.Equal("past_due", await SubscriptionStatusAsync(subscriptionId));

        await SetTokenAsync(customer, "tok_ok");
        var ops = await App.ClientAsync(ApiRole.BillingOps);
        TestData.Ensure(await ops.PostAsync($"/v1/invoices/{prorationInvoice}/pay"), 200);
        await CollectAsync();
        Assert.Equal("paid", (await InvoiceAsync(prorationInvoice)).GetProperty("status").GetString());
        Assert.Equal("past_due", await SubscriptionStatusAsync(subscriptionId));

        var retry = await ops.PostAsync($"/v1/invoices/{cycleInvoice}/pay");
        Assert.Equal(1, retry["declineCount"].GetInt32());
        await CollectAsync();

        Assert.Equal("paid", (await InvoiceAsync(cycleInvoice)).GetProperty("status").GetString());
        Assert.Equal("active", await SubscriptionStatusAsync(subscriptionId));
    }

    [Fact]
    public async Task RetryIsRefusedWhileAPaymentIsInProgress()
    {
        var (_, _, invoiceId) = await SubscribeAsync("tok_timeout_then_ok");
        await CollectAsync();
        var ops = await App.ClientAsync(ApiRole.BillingOps);

        var retry = await ops.PostAsync($"/v1/invoices/{invoiceId}/pay");
        var voided = await ops.PostAsync($"/v1/invoices/{invoiceId}/void");

        Assert.Equal(409, retry.Status);
        Assert.Equal("payment_in_progress", retry.ErrorCode);
        Assert.Equal(409, voided.Status);
        Assert.Equal("payment_in_progress", voided.ErrorCode);
    }
}
