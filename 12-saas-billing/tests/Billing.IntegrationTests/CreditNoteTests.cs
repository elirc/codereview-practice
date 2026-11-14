using System.Text.Json;
using Billing.Core.Data;
using Billing.Core.Services;
using Billing.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Billing.IntegrationTests;

public sealed class CreditNoteTests(BillingApp app) : IntegrationTest(app)
{
    private ApiClient? _ops;

    private async Task<ApiClient> OpsAsync() => _ops ??= await App.ClientAsync(ApiRole.BillingOps);

    /// <summary>Creates and finalises a manual invoice with one line of 16.13 at 8.25% tax (total 17.46).</summary>
    private async Task<(Guid Customer, Guid Invoice, Guid Line)> OpenInvoiceAsync(string? token = "tok_ok", long startingCredit = 0)
    {
        await Data.TaxRateAsync("US", null, 825);
        var customer = await Data.CustomerAsync(token: token);
        var ops = await OpsAsync();
        if (startingCredit > 0)
        {
            TestData.Ensure(
                await ops.PostAsync($"/v1/customers/{customer}/credit-adjustments", new { amountMinor = startingCredit, reason = "Prepaid" }, $"grant-{customer:N}"),
                201);
        }

        var draft = await ops.PostAsync(
            "/v1/invoices",
            new { customerId = customer, lines = new[] { new { description = "Consulting", quantity = 1, unitAmountMinor = 1613 } } });
        TestData.Ensure(draft, 201);
        var finalized = await ops.PostAsync($"/v1/invoices/{draft.Id}/finalize");
        TestData.Ensure(finalized, 200);
        return (customer, draft.Id, finalized["lines"][0].GetProperty("id").GetGuid());
    }

    private async Task<(Guid Customer, Guid Invoice, Guid Line)> PaidInvoiceAsync(string token = "tok_ok", long startingCredit = 0)
    {
        var created = await OpenInvoiceAsync(token, startingCredit);
        await App.RunLoopAsync<PaymentRun>();
        Assert.Equal("paid", (await InvoiceAsync(created.Invoice)).GetProperty("status").GetString());
        return created;
    }

    private async Task<JsonElement> InvoiceAsync(Guid id) => (await (await OpsAsync()).GetAsync($"/v1/invoices/{id}")).Json;

    private async Task<ApiResponse> CreditAsync(Guid invoice, Guid line, long amount, string disposition, string? key = null) =>
        await (await OpsAsync()).PostAsync(
            $"/v1/invoices/{invoice}/credit-notes",
            new { lines = new[] { new { invoiceLineId = line, amountMinor = amount } }, reason = "Service credit", disposition },
            key ?? $"cn-{Guid.NewGuid():N}");

    private Task<long> BalanceAsync(Guid customer) =>
        App.WithDbAsync(db => db.Customers.Where(c => c.Id == customer).Select(c => c.CreditBalanceMinor).SingleAsync());

    private Task<long> LedgerSumAsync(Guid customer) =>
        App.WithDbAsync(db => db.CreditBalanceTransactions.Where(t => t.CustomerId == customer).SumAsync(t => t.AmountMinor));

    [Fact]
    public async Task ReduceDueLowersTheRemainingAmountAndSettlesTheInvoiceWhenItReachesZero()
    {
        var (_, invoice, line) = await OpenInvoiceAsync(token: null);

        var partial = await CreditAsync(invoice, line, 500, "reduce_due");
        Assert.Equal(201, partial.Status);
        Assert.Equal("CN-2026-000001", partial["number"].GetString());
        Assert.Equal(500 + 41, partial["totalMinor"].GetInt64());
        Assert.Equal(1746 - 541, (await InvoiceAsync(invoice)).GetProperty("amountRemainingMinor").GetInt64());

        var rest = await CreditAsync(invoice, line, 1113, "reduce_due");
        Assert.Equal(1113 + 92, rest["totalMinor"].GetInt64());

        var settled = await InvoiceAsync(invoice);
        Assert.Equal("paid", settled.GetProperty("status").GetString());
        Assert.Equal(0, settled.GetProperty("amountRemainingMinor").GetInt64());
        Assert.Equal(JsonValueKind.Null, settled.GetProperty("nextPaymentAttemptAt").ValueKind);
        Assert.Equal(133, settled.GetProperty("lines")[0].GetProperty("creditedTaxMinor").GetInt64());
        Assert.Equal(2, settled.GetProperty("creditNotes").GetArrayLength());

        await App.RunLoopAsync<PaymentRun>();
        Assert.Equal(0, (await InvoiceAsync(invoice)).GetProperty("attempts").GetArrayLength());
    }

    [Fact]
    public async Task CreditBeyondTheLineOrTheRemainingAmountIsRejected()
    {
        var (_, invoice, line) = await OpenInvoiceAsync(token: null);

        var tooMuch = await CreditAsync(invoice, line, 1614, "reduce_due");
        var wrongDisposition = await CreditAsync(invoice, line, 100, "refund");
        var unknownLine = await CreditAsync(invoice, Guid.NewGuid(), 100, "reduce_due");

        Assert.Equal(422, tooMuch.Status);
        Assert.Equal("exceeds_creditable", tooMuch.ErrorCode);
        Assert.Equal(409, wrongDisposition.Status);
        Assert.Equal(400, unknownLine.Status);
    }

    [Fact]
    public async Task ConcurrentCreditNotesCannotTogetherExceedALine()
    {
        var (_, invoice, line) = await OpenInvoiceAsync(token: null);

        var results = await Task.WhenAll(CreditAsync(invoice, line, 1000, "reduce_due"), CreditAsync(invoice, line, 1000, "reduce_due"));

        Assert.Equal(new[] { 201, 422 }, results.Select(r => r.Status).Order().ToArray());
        Assert.Equal(1000, (await InvoiceAsync(invoice)).GetProperty("lines")[0].GetProperty("creditedMinor").GetInt64());
    }

    [Fact]
    public async Task CreditNoteDuringAnInFlightPaymentIsAConflict()
    {
        var (_, invoice, line) = await OpenInvoiceAsync(token: "tok_timeout_then_ok");
        await App.RunLoopAsync<PaymentRun>();

        var response = await CreditAsync(invoice, line, 100, "reduce_due");

        Assert.Equal(409, response.Status);
        Assert.Equal("payment_in_progress", response.ErrorCode);
    }

    [Fact]
    public async Task CreditBalanceDispositionAddsToTheCustomersBalance()
    {
        var (customer, invoice, line) = await PaidInvoiceAsync();

        var response = await CreditAsync(invoice, line, 1613, "credit_balance");

        Assert.Equal(1746, response["totalMinor"].GetInt64());
        Assert.Equal(1746, await BalanceAsync(customer));
        Assert.Equal(1746, await LedgerSumAsync(customer));
        Assert.Equal(1746, (await InvoiceAsync(invoice)).GetProperty("creditedMinor").GetInt64());
    }

    [Fact]
    public async Task RefundIsSentToTheGatewayOnce()
    {
        var (_, invoice, line) = await PaidInvoiceAsync();

        var response = await CreditAsync(invoice, line, 1000, "refund");
        Assert.Equal("pending", response["refundStatus"].GetString());
        Assert.Equal(1083, (await InvoiceAsync(invoice)).GetProperty("refundedMinor").GetInt64());

        await App.RunLoopAsync<RefundRun>();
        await App.RunLoopAsync<RefundRun>();

        var note = await (await OpsAsync()).GetAsync($"/v1/credit-notes/{response.Id}");
        Assert.Equal("succeeded", note["refundStatus"].GetString());
        var call = Assert.Single(App.Gateway.RefundCalls);
        Assert.Equal(1083, call.AmountMinor);
        Assert.Equal(response.Id.ToString(), call.IdempotencyKey);
    }

    [Fact]
    public async Task RefundsCannotExceedWhatWasPaidLessEarlierRefunds()
    {
        var (_, invoice, line) = await PaidInvoiceAsync(startingCredit: 1000);
        Assert.Equal(746, (await InvoiceAsync(invoice)).GetProperty("amountPaidMinor").GetInt64());

        var whole = await CreditAsync(invoice, line, 1613, "refund");
        var first = await CreditAsync(invoice, line, 500, "refund");
        var second = await CreditAsync(invoice, line, 600, "refund");

        Assert.Equal(422, whole.Status);
        Assert.Equal("exceeds_refundable", whole.ErrorCode);
        Assert.Equal(201, first.Status);
        Assert.Equal(422, second.Status);
        Assert.Equal("exceeds_refundable", second.ErrorCode);
        Assert.Equal(541, (await InvoiceAsync(invoice)).GetProperty("refundedMinor").GetInt64());
    }

    [Fact]
    public async Task RefundThatFailsFiveTimesIsFailedAndRefundableAgain()
    {
        var (_, invoice, line) = await PaidInvoiceAsync("tok_ok_refund_fails");
        var refund = await CreditAsync(invoice, line, 1000, "refund");

        for (var pass = 0; pass < 4; pass++)
        {
            await App.RunLoopAsync<RefundRun>();
        }

        Assert.Equal("pending", (await (await OpsAsync()).GetAsync($"/v1/credit-notes/{refund.Id}"))["refundStatus"].GetString());
        await App.RunLoopAsync<RefundRun>();
        await App.RunLoopAsync<RefundRun>();

        Assert.Equal("failed", (await (await OpsAsync()).GetAsync($"/v1/credit-notes/{refund.Id}"))["refundStatus"].GetString());
        Assert.Equal(5, App.Gateway.RefundCalls.Count);
        Assert.Equal(0, (await InvoiceAsync(invoice)).GetProperty("refundedMinor").GetInt64());
        var types = await App.WithDbAsync(db => db.WebhookEvents.Select(e => e.Type).ToListAsync());
        Assert.Single(types, t => t == "credit_note.refund_failed");

        var again = await CreditAsync(invoice, line, 613, "refund");
        Assert.Equal(201, again.Status);
    }

    [Fact]
    public async Task ReplayedCreditNoteIsIssuedOnce()
    {
        var (_, invoice, line) = await OpenInvoiceAsync(token: null);

        var first = await CreditAsync(invoice, line, 100, "reduce_due", key: "credit-replay-1");
        var second = await CreditAsync(invoice, line, 100, "reduce_due", key: "credit-replay-1");

        Assert.Equal(first.Text, second.Text);
        Assert.Single((await InvoiceAsync(invoice)).GetProperty("creditNotes").EnumerateArray());
    }

    [Fact]
    public async Task ManualAdjustmentsKeepTheBalanceEqualToTheLedgerAndNeverNegative()
    {
        var customer = await Data.CustomerAsync();
        var ops = await OpsAsync();

        var credit = await ops.PostAsync($"/v1/customers/{customer}/credit-adjustments", new { amountMinor = 500, reason = "Goodwill" }, "adjust-key-1");
        var debit = await ops.PostAsync($"/v1/customers/{customer}/credit-adjustments", new { amountMinor = -200, reason = "Correction" }, "adjust-key-2");
        var overdraw = await ops.PostAsync($"/v1/customers/{customer}/credit-adjustments", new { amountMinor = -400, reason = "Too much" }, "adjust-key-3");
        var missingKey = await ops.PostAsync($"/v1/customers/{customer}/credit-adjustments", new { amountMinor = 1, reason = "No key" });

        Assert.Equal(201, credit.Status);
        Assert.Equal(300, debit["balanceAfterMinor"].GetInt64());
        Assert.Equal(422, overdraw.Status);
        Assert.Equal("insufficient_credit", overdraw.ErrorCode);
        Assert.Equal(400, missingKey.Status);
        Assert.Equal(300, await BalanceAsync(customer));
        Assert.Equal(300, await LedgerSumAsync(customer));

        var transactions = await ops.GetAsync($"/v1/customers/{customer}/credit-transactions");
        Assert.Equal(2, transactions["data"].GetArrayLength());
    }
}
