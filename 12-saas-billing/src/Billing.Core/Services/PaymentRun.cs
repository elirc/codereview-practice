using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Payments;
using Billing.Core.Views;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Services;

/// <summary>Collects open invoices whose next payment attempt is due.</summary>
public sealed class PaymentRun(
    BillingDbContext db,
    IServiceScopeFactory scopes,
    RequestContext request,
    ILogger<PaymentRun> logger) : ILoopRunner
{
    public const int BatchSize = 20;

    public async Task RunOnceAsync(DateTimeOffset now, CancellationToken ct)
    {
        var due = await db.Invoices.AsNoTracking()
            .Where(i => i.Status == InvoiceStatus.Open && i.NextPaymentAttemptAt <= now)
            .OrderBy(i => i.NextPaymentAttemptAt)
            .Select(i => i.Id)
            .Take(BatchSize)
            .ToListAsync(ct);

        foreach (var invoiceId in due)
        {
            await using var scope = scopes.CreateRunScope(request);
            var collector = scope.ServiceProvider.GetRequiredService<InvoiceCollector>();
            try
            {
                await collector.CollectAsync(invoiceId, now, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Payment collection failed for invoice {InvoiceId}", invoiceId);
            }
        }
    }
}

/// <summary>Runs one payment attempt for one invoice.</summary>
public sealed class InvoiceCollector(
    BillingDbContext db,
    TimeProvider clock,
    IPaymentGateway gateway,
    InvoiceSettlement settlement,
    ILogger<InvoiceCollector> logger)
{
    public const string NoPaymentMethod = "no_payment_method";
    public static readonly TimeSpan AttemptTimeout = TimeSpan.FromMinutes(15);

    private sealed record PreparedAttempt(Guid AttemptId, int AttemptNo, string IdempotencyKey, long AmountMinor, string Currency, string? Token, bool Lookup);

    /// <summary>
    /// Starts a new attempt (or picks up an unresolved one) for a due invoice, asks the gateway for the outcome and
    /// stores it; does nothing when the invoice is no longer due or is held by another worker.
    /// </summary>
    public async Task CollectAsync(Guid invoiceId, DateTimeOffset now, CancellationToken ct)
    {
        var prepared = await PrepareAsync(invoiceId, now, ct);
        if (prepared is null)
        {
            return;
        }

        logger.LogInformation(
            "Payment attempt {AttemptNo} for invoice {InvoiceId} started ({Mode})",
            prepared.AttemptNo,
            invoiceId,
            prepared.Lookup ? "lookup" : "charge");

        GatewayResult? result;
        try
        {
            result = prepared.Lookup
                ? await gateway.LookupAsync(prepared.IdempotencyKey, ct)
                : await gateway.ChargeAsync(prepared.Token!, prepared.AmountMinor, prepared.Currency, prepared.IdempotencyKey, ct);
        }
        catch (GatewayTimeoutException)
        {
            result = null;
        }

        db.ChangeTracker.Clear();
        await RecordAsync(invoiceId, prepared, result, ct);
    }

    private async Task<PreparedAttempt?> PrepareAsync(Guid invoiceId, DateTimeOffset now, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var subscription = await LockSubscriptionOfAsync(invoiceId, ct);
        var invoice = (await db.Invoices
                .FromSql($"SELECT * FROM invoices WHERE id = {invoiceId} AND status = 'open' AND next_payment_attempt_at <= {now} FOR UPDATE SKIP LOCKED")
                .ToListAsync(ct))
            .SingleOrDefault();
        if (invoice is null)
        {
            return null;
        }

        var latest = await db.PaymentAttempts
            .Where(a => a.InvoiceId == invoiceId)
            .OrderByDescending(a => a.AttemptNo)
            .FirstOrDefaultAsync(ct);
        if (latest is { Status: PaymentAttemptStatus.Pending or PaymentAttemptStatus.Unknown })
        {
            invoice.NextPaymentAttemptAt = clock.GetUtcNow() + AttemptTimeout;
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return new PreparedAttempt(latest.Id, latest.AttemptNo, latest.IdempotencyKey, latest.AmountMinor, invoice.Currency, null, true);
        }

        var token = await db.Customers.Where(c => c.Id == invoice.CustomerId).Select(c => c.PaymentMethodToken).SingleAsync(ct);
        var attemptNo = invoice.AttemptCount + 1;
        var attempt = new PaymentAttempt
        {
            Id = Ids.New(clock),
            InvoiceId = invoice.Id,
            AttemptNo = attemptNo,
            IdempotencyKey = $"{invoice.Id}:{attemptNo}",
            AmountMinor = invoice.AmountRemainingMinor,
            Status = PaymentAttemptStatus.Pending,
            CreatedAt = clock.GetUtcNow(),
        };
        db.PaymentAttempts.Add(attempt);
        invoice.AttemptCount = attemptNo;

        if (token is null)
        {
            attempt.Status = PaymentAttemptStatus.Failed;
            attempt.FailureCode = NoPaymentMethod;
            attempt.CountsAsDecline = true;
            attempt.CompletedAt = clock.GetUtcNow();
            logger.LogInformation("Invoice {InvoiceId} has no payment method; attempt {AttemptNo} failed", invoice.Id, attemptNo);
            await settlement.ApplyDeclineAsync(invoice, subscription, NoPaymentMethod, ct);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return null;
        }

        invoice.NextPaymentAttemptAt = clock.GetUtcNow() + AttemptTimeout;
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return new PreparedAttempt(attempt.Id, attemptNo, attempt.IdempotencyKey, attempt.AmountMinor, invoice.Currency, token, false);
    }

    private async Task RecordAsync(Guid invoiceId, PreparedAttempt prepared, GatewayResult? result, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var subscription = await LockSubscriptionOfAsync(invoiceId, ct);
        var invoice = await db.LockInvoiceAsync(invoiceId, ct) ?? throw DomainException.NotFound("Invoice");
        var attempt = await db.PaymentAttempts.SingleAsync(a => a.Id == prepared.AttemptId, ct);
        if (attempt.Status is not (PaymentAttemptStatus.Pending or PaymentAttemptStatus.Unknown))
        {
            return;
        }

        var now = clock.GetUtcNow();
        switch (result)
        {
            case null:
                attempt.Status = PaymentAttemptStatus.Unknown;
                invoice.NextPaymentAttemptAt = now + AttemptTimeout;
                logger.LogWarning("Payment attempt {AttemptNo} for invoice {InvoiceId} timed out", attempt.AttemptNo, invoiceId);
                break;

            case GatewayResult.Succeeded succeeded:
                attempt.Status = PaymentAttemptStatus.Succeeded;
                attempt.GatewayChargeId = succeeded.ChargeId;
                attempt.CompletedAt = now;
                invoice.AmountPaidMinor += attempt.AmountMinor;
                if (invoice.Status == InvoiceStatus.Open)
                {
                    invoice.AmountRemainingMinor = 0;
                    await settlement.MarkPaidAsync(invoice, subscription, ct);
                }

                logger.LogInformation("Payment attempt {AttemptNo} for invoice {InvoiceId} succeeded", attempt.AttemptNo, invoiceId);
                break;

            case GatewayResult.Declined declined:
                attempt.Status = PaymentAttemptStatus.Failed;
                attempt.FailureCode = declined.Code;
                attempt.CountsAsDecline = true;
                attempt.CompletedAt = now;
                await settlement.ApplyDeclineAsync(invoice, subscription, declined.Code, ct);
                break;

            case GatewayResult.NotFound:
                attempt.Status = PaymentAttemptStatus.Failed;
                attempt.FailureCode = "not_processed";
                attempt.CountsAsDecline = false;
                attempt.CompletedAt = now;
                invoice.NextPaymentAttemptAt = now;
                logger.LogInformation("Payment attempt {AttemptNo} for invoice {InvoiceId} was not processed by the gateway", attempt.AttemptNo, invoiceId);
                break;
        }

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
    }

    private async Task<Subscription?> LockSubscriptionOfAsync(Guid invoiceId, CancellationToken ct)
    {
        var subscriptionId = await db.Invoices.AsNoTracking()
            .Where(i => i.Id == invoiceId)
            .Select(i => i.SubscriptionId)
            .SingleOrDefaultAsync(ct);
        return subscriptionId is { } id ? await db.LockSubscriptionAsync(id, ct) : null;
    }
}

/// <summary>Operator actions on invoice collection.</summary>
public sealed class PaymentService(BillingDbContext db, TimeProvider clock, InvoiceService invoices, ViewLoader views)
{
    /// <summary>Makes an open invoice with no payment in progress due for collection now.</summary>
    public Task<InvoiceView> RetryNowAsync(Guid invoiceId, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var locked = await db.LockInvoiceWithSubscriptionAsync(invoiceId, ct) ?? throw DomainException.NotFound("Invoice");
                if (locked.Invoice.Status != InvoiceStatus.Open)
                {
                    throw DomainException.InvalidState("Only open invoices can be retried.");
                }

                await invoices.EnsureNoPaymentInProgressAsync(invoiceId, ct);
                locked.Invoice.NextPaymentAttemptAt = clock.GetUtcNow();
                await db.SaveChangesAsync(ct);
                return await views.InvoiceAsync(invoiceId, ct) ?? throw DomainException.NotFound("Invoice");
            },
            ct);
}
