using Billing.Core.Data;
using Billing.Core.Payments;
using Billing.Core.Views;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Services;

/// <summary>Sends pending credit-note refunds to the gateway.</summary>
public sealed class RefundRun(
    BillingDbContext db,
    IServiceScopeFactory scopes,
    RequestContext request,
    ILogger<RefundRun> logger) : ILoopRunner
{
    public const int BatchSize = 20;

    public async Task RunOnceAsync(DateTimeOffset now, CancellationToken ct)
    {
        var pending = await db.CreditNotes.AsNoTracking()
            .Where(n => n.RefundStatus == RefundStatus.Pending)
            .OrderBy(n => n.CreatedAt)
            .Select(n => n.Id)
            .Take(BatchSize)
            .ToListAsync(ct);

        foreach (var creditNoteId in pending)
        {
            await using var scope = scopes.CreateRunScope(request);
            var processor = scope.ServiceProvider.GetRequiredService<RefundProcessor>();
            try
            {
                await processor.ProcessAsync(creditNoteId, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Refund failed unexpectedly for credit note {CreditNoteId}", creditNoteId);
            }
        }
    }
}

/// <summary>Refunds one credit note.</summary>
public sealed class RefundProcessor(
    BillingDbContext db,
    IPaymentGateway gateway,
    EventRecorder events,
    ViewLoader views,
    ILogger<RefundProcessor> logger)
{
    public const int MaxAttempts = 5;

    /// <summary>
    /// Asks the gateway to refund a pending credit note against the invoice's successful charge; after the last
    /// failed attempt the refund is marked failed and its amount is no longer counted as refunded.
    /// </summary>
    public async Task ProcessAsync(Guid creditNoteId, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var note = (await db.CreditNotes
                .FromSql($"SELECT * FROM credit_notes WHERE id = {creditNoteId} AND refund_status = 'pending' FOR UPDATE SKIP LOCKED")
                .ToListAsync(ct))
            .SingleOrDefault();
        if (note is null)
        {
            return;
        }

        var chargeId = await db.PaymentAttempts.AsNoTracking()
            .Where(a => a.InvoiceId == note.InvoiceId && a.Status == PaymentAttemptStatus.Succeeded && a.GatewayChargeId != null)
            .OrderByDescending(a => a.AttemptNo)
            .Select(a => a.GatewayChargeId)
            .FirstOrDefaultAsync(ct);

        logger.LogInformation("Refund of credit note {CreditNoteId} attempt {Attempt} started", note.Id, note.RefundAttempts + 1);
        try
        {
            if (chargeId is null)
            {
                throw new PaymentGatewayException("The invoice has no successful charge to refund.");
            }

            await gateway.RefundAsync(chargeId, note.TotalMinor, note.Id.ToString(), ct);
            note.RefundStatus = RefundStatus.Succeeded;
            logger.LogInformation("Refund of credit note {CreditNoteId} succeeded", note.Id);
        }
        catch (PaymentGatewayException ex)
        {
            note.RefundAttempts++;
            logger.LogWarning("Refund of credit note {CreditNoteId} attempt {Attempt} failed: {Error}", note.Id, note.RefundAttempts, ex.Message);
            if (note.RefundAttempts >= MaxAttempts)
            {
                note.RefundStatus = RefundStatus.Failed;
                var invoice = await db.LockInvoiceAsync(note.InvoiceId, ct)
                    ?? throw new InvalidOperationException($"Invoice {note.InvoiceId} does not exist.");
                invoice.RefundedMinor -= note.TotalMinor;
                await db.SaveChangesAsync(ct);
                var view = await views.CreditNoteAsync(note.Id, ct)
                    ?? throw new InvalidOperationException($"Credit note {note.Id} does not exist.");
                await events.RecordAsync(EventTypes.CreditNoteRefundFailed, "credit_note", note.Id, view, null, ct);
            }
        }

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
    }
}
