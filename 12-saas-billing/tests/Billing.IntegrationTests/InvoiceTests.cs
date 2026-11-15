using Billing.Core.Data;
using Billing.Core.Services;
using Billing.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Xunit;

namespace Billing.IntegrationTests;

[Collection(DatabaseCollection.Name)]
public sealed class InvoiceTests(BillingApp app) : IntegrationTest(app)
{
    private async Task<(ApiClient Ops, Guid InvoiceId)> DraftAsync(Guid customerId, params (long Quantity, long Unit)[] lines)
    {
        var ops = await App.ClientAsync(ApiRole.BillingOps);
        var response = await ops.PostAsync(
            "/v1/invoices",
            new
            {
                customerId,
                lines = lines.Select((l, i) => new { description = $"Item {i + 1}", quantity = l.Quantity, unitAmountMinor = l.Unit }).ToArray(),
            });
        TestData.Ensure(response, 201);
        return (ops, response.Id);
    }

    [Fact]
    public async Task FinalizingAManualInvoiceTaxesLinesAndAssignsANumber()
    {
        await Data.TaxRateAsync("US", null, 1000);
        var customer = await Data.CustomerAsync();
        var (ops, id) = await DraftAsync(customer, (1, 33), (1, 33), (1, 33));

        var response = await ops.PostAsync($"/v1/invoices/{id}/finalize");

        Assert.Equal(200, response.Status);
        Assert.Equal("open", response["status"].GetString());
        Assert.Equal("INV-2026-000001", response["number"].GetString());
        Assert.Equal(99, response["subtotalMinor"].GetInt64());
        Assert.Equal(9, response["taxMinor"].GetInt64());
        Assert.Equal(108, response["totalMinor"].GetInt64());
        Assert.Equal(108, response["amountRemainingMinor"].GetInt64());
        Assert.Equal("2026-01-15", response["issueDate"].GetString());
        Assert.Equal("2026-01-15T12:00:00Z", response["nextPaymentAttemptAt"].GetString());
    }

    [Fact]
    public async Task RegionalRateWinsAndExemptCustomersPayNoTax()
    {
        await Data.TaxRateAsync("US", null, 500);
        await Data.TaxRateAsync("US", "CA", 825);
        var californian = await Data.CustomerAsync(region: "CA");
        var exempt = await Data.CustomerAsync(region: "CA", taxExempt: true);
        var (ops, first) = await DraftAsync(californian, (1, 10_000));
        var (_, second) = await DraftAsync(exempt, (1, 10_000));

        var regional = await ops.PostAsync($"/v1/invoices/{first}/finalize");
        var none = await ops.PostAsync($"/v1/invoices/{second}/finalize");

        Assert.Equal(825, regional["taxMinor"].GetInt64());
        Assert.Equal(0, none["taxMinor"].GetInt64());
        Assert.True(none["billTo"].GetProperty("taxExempt").GetBoolean());
    }

    [Fact]
    public async Task RateEndingOnTheIssueDateDoesNotApply()
    {
        await Data.TaxRateAsync("US", null, 500, "2020-01-01", "2026-01-15");
        await Data.TaxRateAsync("US", null, 700, "2026-01-15");
        var customer = await Data.CustomerAsync();
        var (ops, id) = await DraftAsync(customer, (1, 10_000));

        var response = await ops.PostAsync($"/v1/invoices/{id}/finalize");

        Assert.Equal(700, response["taxMinor"].GetInt64());
    }

    [Fact]
    public async Task NumbersStayGaplessWhenAFinalizationRollsBack()
    {
        var customer = await Data.CustomerAsync();
        var (ops, rolledBack) = await DraftAsync(customer, (1, 1000));
        var (_, next) = await DraftAsync(customer, (1, 1000));

        await using (var scope = App.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            var invoices = scope.ServiceProvider.GetRequiredService<InvoiceService>();
            await using var transaction = await db.Database.BeginTransactionAsync();
            var finalized = await invoices.FinalizeAsync(rolledBack, default);
            Assert.Equal("INV-2026-000001", finalized.Number);
            await transaction.RollbackAsync();
        }

        var second = await ops.PostAsync($"/v1/invoices/{next}/finalize");
        var first = await ops.PostAsync($"/v1/invoices/{rolledBack}/finalize");

        Assert.Equal("INV-2026-000001", second["number"].GetString());
        Assert.Equal("INV-2026-000002", first["number"].GetString());
    }

    [Fact]
    public async Task FirstInvoiceOfANewYearStartsAtOne()
    {
        var customer = await Data.CustomerAsync();
        var (ops, december) = await DraftAsync(customer, (1, 1000));
        var (_, january) = await DraftAsync(customer, (1, 1000));
        Clock.Set(new DateTimeOffset(2026, 12, 31, 12, 0, 0, TimeSpan.Zero));
        Assert.Equal("INV-2026-000001", (await ops.PostAsync($"/v1/invoices/{december}/finalize"))["number"].GetString());

        Clock.Set(new DateTimeOffset(2027, 1, 1, 12, 0, 0, TimeSpan.Zero));
        var response = await ops.PostAsync($"/v1/invoices/{january}/finalize");

        Assert.Equal("INV-2027-000001", response["number"].GetString());
    }

    [Fact]
    public async Task CreditBalanceIsAppliedAtFinalization()
    {
        var customer = await Data.CustomerAsync();
        await GrantCreditAsync(customer, 400);
        var (ops, id) = await DraftAsync(customer, (1, 1000));

        var response = await ops.PostAsync($"/v1/invoices/{id}/finalize");

        Assert.Equal(400, response["creditAppliedMinor"].GetInt64());
        Assert.Equal(600, response["amountDueMinor"].GetInt64());
        Assert.Equal("open", response["status"].GetString());
        Assert.Equal(0, await BalanceAsync(customer));
    }

    [Fact]
    public async Task LargerCreditBalancePaysTheInvoiceAtOnceAndKeepsTheRest()
    {
        var customer = await Data.CustomerAsync();
        await GrantCreditAsync(customer, 5000);
        var (ops, id) = await DraftAsync(customer, (1, 1000));

        var response = await ops.PostAsync($"/v1/invoices/{id}/finalize");

        Assert.Equal("paid", response["status"].GetString());
        Assert.Equal(0, response["amountRemainingMinor"].GetInt64());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, response["nextPaymentAttemptAt"].ValueKind);
        Assert.Equal(0, response["attempts"].GetArrayLength());
        Assert.Equal(4000, await BalanceAsync(customer));
    }

    [Fact]
    public async Task VoidingReturnsAppliedCreditOnceAndCannotBeRepeated()
    {
        var customer = await Data.CustomerAsync();
        await GrantCreditAsync(customer, 300);
        var (ops, id) = await DraftAsync(customer, (1, 1000));
        await ops.PostAsync($"/v1/invoices/{id}/finalize");

        var voided = await ops.PostAsync($"/v1/invoices/{id}/void");
        var again = await ops.PostAsync($"/v1/invoices/{id}/void");

        Assert.Equal(200, voided.Status);
        Assert.Equal("void", voided["status"].GetString());
        Assert.Equal(0, voided["amountRemainingMinor"].GetInt64());
        Assert.Equal(409, again.Status);
        Assert.Equal(300, await BalanceAsync(customer));
        Assert.Equal(300, await LedgerSumAsync(customer));
    }

    [Fact]
    public async Task DraftCreatedWithAnIdempotencyKeyIsCreatedOnce()
    {
        var customer = await Data.CustomerAsync();
        var ops = await App.ClientAsync(ApiRole.BillingOps);
        var body = new { customerId = customer, lines = new[] { new { description = "Setup", quantity = 1, unitAmountMinor = 2500 } } };

        var first = await ops.PostAsync("/v1/invoices", body, "draft-key-1");
        var second = await ops.PostAsync("/v1/invoices", body, "draft-key-1");

        Assert.Equal(201, first.Status);
        Assert.Equal(201, second.Status);
        Assert.Equal(first.Id, second.Id);
        Assert.Equal(1, await App.WithDbAsync(db => db.Invoices.CountAsync(i => i.CustomerId == customer)));
    }

    [Fact]
    public async Task RetriedFinalizationWithTheSameKeyReturnsTheOriginalResponse()
    {
        var customer = await Data.CustomerAsync();
        var (ops, id) = await DraftAsync(customer, (1, 1000));

        var first = await ops.PostAsync($"/v1/invoices/{id}/finalize", idempotencyKey: "finalize-key-1");
        var retried = await ops.PostAsync($"/v1/invoices/{id}/finalize", idempotencyKey: "finalize-key-1");
        var withoutKey = await ops.PostAsync($"/v1/invoices/{id}/finalize");

        Assert.Equal(200, first.Status);
        Assert.Equal(first.Text, retried.Text);
        Assert.Equal(409, withoutKey.Status);
    }

    [Fact]
    public async Task FinalizedInvoiceLinesCannotBeChangedThroughTheApi()
    {
        var customer = await Data.CustomerAsync();
        var (ops, id) = await DraftAsync(customer, (1, 1000));
        Assert.Equal(200, (await ops.PutAsync($"/v1/invoices/{id}/lines", new { lines = new[] { new { description = "New", quantity = 2, unitAmountMinor = 700 } } })).Status);
        await ops.PostAsync($"/v1/invoices/{id}/finalize");

        var response = await ops.PutAsync($"/v1/invoices/{id}/lines", new { lines = new[] { new { description = "Later", quantity = 1, unitAmountMinor = 1 } } });
        var refinalize = await ops.PostAsync($"/v1/invoices/{id}/finalize");
        var stored = await ops.GetAsync($"/v1/invoices/{id}");

        Assert.Equal(409, response.Status);
        Assert.Equal(409, refinalize.Status);
        Assert.Equal(1400, stored["totalMinor"].GetInt64());
        Assert.Single(stored["lines"].EnumerateArray());
    }

    [Fact]
    public async Task FinalizedInvoiceCannotBeChangedByDirectSql()
    {
        var customer = await Data.CustomerAsync();
        var (ops, id) = await DraftAsync(customer, (1, 1000));
        await ops.PostAsync($"/v1/invoices/{id}/finalize");

        await App.WithDbAsync(async db =>
        {
            await Assert.ThrowsAsync<PostgresException>(() => db.Database.ExecuteSqlAsync($"UPDATE invoices SET total_minor = 1 WHERE id = {id}"));
            await Assert.ThrowsAsync<PostgresException>(() => db.Database.ExecuteSqlAsync($"UPDATE invoices SET number = 'INV-X' WHERE id = {id}"));
            await Assert.ThrowsAsync<PostgresException>(() => db.Database.ExecuteSqlAsync($"UPDATE invoices SET status = 'draft' WHERE id = {id}"));
            await Assert.ThrowsAsync<PostgresException>(() => db.Database.ExecuteSqlAsync($"UPDATE invoice_lines SET amount_minor = 1 WHERE invoice_id = {id}"));
            await Assert.ThrowsAsync<PostgresException>(() => db.Database.ExecuteSqlAsync($"DELETE FROM invoice_lines WHERE invoice_id = {id}"));
            await Assert.ThrowsAsync<PostgresException>(() => db.Database.ExecuteSqlAsync($"INSERT INTO invoice_lines (id, invoice_id, line_no, kind, description, quantity, amount_minor, tax_rate_bps, tax_minor, credited_minor, credited_tax_minor) VALUES ({Guid.NewGuid()}, {id}, 9, 'manual', 'x', 1, 1, 0, 0, 0, 0)"));
            await Assert.ThrowsAsync<PostgresException>(() => db.Database.ExecuteSqlAsync($"DELETE FROM invoices WHERE id = {id}"));

            var allowed = await db.Database.ExecuteSqlAsync($"UPDATE invoices SET decline_count = decline_count + 1 WHERE id = {id}");
            Assert.Equal(1, allowed);
        });
    }

    [Fact]
    public async Task InvoiceWithoutLinesCannotBeFinalized()
    {
        var customer = await Data.CustomerAsync();
        var id = Guid.NewGuid();
        await App.WithDbAsync(async db =>
        {
            db.Invoices.Add(new Invoice { Id = id, CustomerId = customer, Kind = InvoiceKind.Manual, Status = InvoiceStatus.Draft, Currency = "USD", CreatedAt = Clock.GetUtcNow() });
            await db.SaveChangesAsync();
        });
        var ops = await App.ClientAsync(ApiRole.BillingOps);

        var response = await ops.PostAsync($"/v1/invoices/{id}/finalize");

        Assert.Equal(422, response.Status);
        Assert.Equal("invoice_not_finalizable", response.ErrorCode);
    }

    private async Task GrantCreditAsync(Guid customerId, long amount)
    {
        await using var scope = App.Scope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<CreditLedger>();
        await db.InTransactionAsync(
            async () =>
            {
                var customer = await db.LockCustomerAsync(customerId, default);
                ledger.Post(customer!, amount, CreditTransactionKind.ManualAdjustment, description: "test grant");
                await db.SaveChangesAsync();
            },
            default);
    }

    private Task<long> BalanceAsync(Guid customerId) =>
        App.WithDbAsync(db => db.Customers.Where(c => c.Id == customerId).Select(c => c.CreditBalanceMinor).SingleAsync());

    private Task<long> LedgerSumAsync(Guid customerId) =>
        App.WithDbAsync(db => db.CreditBalanceTransactions.Where(t => t.CustomerId == customerId).SumAsync(t => t.AmountMinor));
}
