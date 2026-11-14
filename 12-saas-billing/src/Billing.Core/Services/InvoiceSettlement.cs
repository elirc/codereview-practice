using Billing.Core.Data;
using Billing.Core.Views;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Services;

/// <summary>Moves open invoices to paid or through the dunning schedule, and keeps the subscription status in step.</summary>
public sealed class InvoiceSettlement(
    BillingDbContext db,
    TimeProvider clock,
    EventRecorder events,
    SubscriptionLifecycle lifecycle,
    ILogger<InvoiceSettlement> logger)
{
    /// <summary>
    /// Marks a locked invoice whose remaining amount is zero as paid, records <c>invoice.paid</c>, and returns a
    /// past-due subscription to active when it has no other declined open invoice.
    /// </summary>
    public async Task MarkPaidAsync(Invoice invoice, Subscription? subscription, CancellationToken ct)
    {
        invoice.Status = InvoiceStatus.Paid;
        invoice.PaidAt = clock.GetUtcNow();
        invoice.NextPaymentAttemptAt = null;
        await db.SaveChangesAsync(ct);
        logger.LogInformation("Invoice {InvoiceId} paid", invoice.Id);
        await events.InvoiceAsync(EventTypes.InvoicePaid, invoice.Id, null, ct);

        if (subscription is not { Status: SubscriptionStatus.PastDue })
        {
            return;
        }

        var otherDeclined = await db.Invoices.AnyAsync(
            i => i.SubscriptionId == subscription.Id && i.Id != invoice.Id && i.Status == InvoiceStatus.Open && i.DeclineCount > 0,
            ct);
        if (!otherDeclined)
        {
            var previous = await SnapshotAsync(subscription, ct);
            subscription.Status = SubscriptionStatus.Active;
            await events.SubscriptionUpdatedAsync(subscription, previous, ct);
        }
    }

    /// <summary>
    /// Counts a decline on a locked invoice: schedules the next attempt, or after the last allowed decline marks the
    /// invoice uncollectible and cancels its subscription; an active subscription becomes past due.
    /// </summary>
    public async Task ApplyDeclineAsync(Invoice invoice, Subscription? subscription, string failureCode, CancellationToken ct)
    {
        invoice.DeclineCount++;
        var retryDelay = DunningSchedule.RetryDelay(invoice.DeclineCount);

        if (retryDelay is { } delay)
        {
            invoice.NextPaymentAttemptAt = clock.GetUtcNow() + delay;
            await db.SaveChangesAsync(ct);
            logger.LogInformation(
                "Invoice {InvoiceId} declined ({FailureCode}), decline {DeclineCount}; next attempt at {NextPaymentAttemptAt}",
                invoice.Id,
                failureCode,
                invoice.DeclineCount,
                invoice.NextPaymentAttemptAt);
            await events.InvoiceAsync(
                EventTypes.InvoicePaymentFailed,
                invoice.Id,
                new Dictionary<string, object?> { ["failureCode"] = failureCode, ["nextPaymentAttemptAt"] = invoice.NextPaymentAttemptAt },
                ct);

            if (subscription is { Status: SubscriptionStatus.Active })
            {
                var previous = await SnapshotAsync(subscription, ct);
                subscription.Status = SubscriptionStatus.PastDue;
                await events.SubscriptionUpdatedAsync(subscription, previous, ct);
            }

            return;
        }

        invoice.Status = InvoiceStatus.Uncollectible;
        invoice.NextPaymentAttemptAt = null;
        await db.SaveChangesAsync(ct);
        logger.LogWarning("Invoice {InvoiceId} marked uncollectible after {DeclineCount} declines", invoice.Id, invoice.DeclineCount);
        await events.InvoiceAsync(EventTypes.InvoiceMarkedUncollectible, invoice.Id, null, ct);

        if (subscription is not null && subscription.Status != SubscriptionStatus.Canceled)
        {
            await lifecycle.CancelNowAsync(subscription, CancelReason.DunningExhausted, ct);
        }
    }

    private async Task<SubscriptionSnapshot> SnapshotAsync(Subscription subscription, CancellationToken ct)
    {
        var code = await db.Plans.Where(p => p.Id == subscription.PlanId).Select(p => p.Code).SingleAsync(ct);
        return new SubscriptionSnapshot(code, subscription.Quantity, subscription.Status);
    }
}
