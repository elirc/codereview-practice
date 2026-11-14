using Billing.Core.Data;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Services;

/// <summary>Bills subscriptions whose next boundary is due, one boundary per subscription per pass.</summary>
public sealed class BillingRun(
    BillingDbContext db,
    IServiceScopeFactory scopes,
    RequestContext request,
    ILogger<BillingRun> logger) : ILoopRunner
{
    public const int BatchSize = 50;

    public async Task RunOnceAsync(DateTimeOffset now, CancellationToken ct)
    {
        var due = await db.Subscriptions.AsNoTracking()
            .Where(s => s.Status != SubscriptionStatus.Canceled && s.NextBillingAt <= now)
            .OrderBy(s => s.NextBillingAt)
            .Select(s => s.Id)
            .Take(BatchSize)
            .ToListAsync(ct);

        foreach (var subscriptionId in due)
        {
            await using var scope = scopes.CreateRunScope(request);
            var biller = scope.ServiceProvider.GetRequiredService<SubscriptionBiller>();
            try
            {
                await biller.BillNextBoundaryAsync(subscriptionId, now, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Billing failed for subscription {SubscriptionId}", subscriptionId);
            }
        }
    }
}

/// <summary>Bills one subscription boundary in its own transaction.</summary>
public sealed class SubscriptionBiller(
    BillingDbContext db,
    SubscriptionCycle cycle,
    UsageRating usage,
    EventRecorder events,
    ILogger<SubscriptionBiller> logger)
{
    /// <summary>
    /// Bills the subscription's due boundary when it is due and not held by another worker; returns whether a
    /// boundary was billed.
    /// </summary>
    public async Task<bool> BillNextBoundaryAsync(Guid subscriptionId, DateTimeOffset now, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var subscription = (await db.Subscriptions
            .FromSql($"SELECT * FROM subscriptions WHERE id = {subscriptionId} AND status <> 'canceled' AND next_billing_at <= {now} FOR UPDATE SKIP LOCKED")
            .ToListAsync(ct))
            .SingleOrDefault();
        if (subscription is null)
        {
            return false;
        }

        var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == subscription.CustomerId, ct);
        var zone = BillingCalendar.FindZone(customer.Timezone);
        logger.LogInformation(
            "Billing subscription {SubscriptionId} boundary after period {PeriodIndex} ({Status})",
            subscription.Id,
            subscription.PeriodIndex,
            subscription.Status);

        try
        {
            if (subscription.Status == SubscriptionStatus.Trialing)
            {
                await EndTrialAsync(subscription, customer, zone, ct);
            }
            else
            {
                await BillPeriodEndAsync(subscription, customer, zone, now, ct);
            }
        }
        catch (DbUpdateException ex) when (ex.IsUniqueViolation("ux_invoices_cycle_period") || ex.IsUniqueViolation("ux_invoices_final"))
        {
            await transaction.RollbackAsync(ct);
            logger.LogWarning("Boundary of subscription {SubscriptionId} is already billed", subscriptionId);
            return false;
        }

        await transaction.CommitAsync(ct);
        logger.LogInformation(
            "Billed subscription {SubscriptionId}; now in period {PeriodIndex} with next billing at {NextBillingAt}",
            subscription.Id,
            subscription.PeriodIndex,
            subscription.NextBillingAt);
        return true;
    }

    private async Task EndTrialAsync(Subscription subscription, Customer customer, TimeZoneInfo zone, CancellationToken ct)
    {
        var plan = await LoadPlanAsync(subscription.PlanId, ct);

        subscription.Status = SubscriptionStatus.Active;
        var period = cycle.OpenPeriod(subscription, plan, 0, zone);
        var invoice = cycle.NewInvoice(subscription, customer.Currency, InvoiceKind.Cycle, period.PeriodStart, period.PeriodEnd);
        cycle.AddAdvanceLines(invoice, plan, subscription.Quantity, period.PeriodStart, period.PeriodEnd);
        await db.SaveChangesAsync(ct);

        await events.SubscriptionAsync(EventTypes.SubscriptionTrialEnded, subscription, null, ct);
        await cycle.SaveAndFinalizeAsync(invoice, ct);
    }

    private async Task BillPeriodEndAsync(Subscription subscription, Customer customer, TimeZoneInfo zone, DateTimeOffset now, CancellationToken ct)
    {
        var ended = await db.SubscriptionPeriods
            .SingleAsync(p => p.SubscriptionId == subscription.Id && p.Index == subscription.PeriodIndex, ct);
        var periodEndsAt = BillingCalendar.StartOfDay(ended.PeriodEnd, zone);
        var sealedUsage = await usage.SealAsync(ended, zone, periodEndsAt, null, ct);
        var ratingPlan = await LoadPlanAsync(ended.PlanId, ct);
        var charges = await usage.RateAsync(sealedUsage, ratingPlan, ct);
        logger.LogInformation(
            "Sealed {EventCount} usage events into period {PeriodIndex} of subscription {SubscriptionId} at {Now}",
            sealedUsage.Count,
            ended.Index,
            subscription.Id,
            now);

        var plan = ended.PlanId == subscription.PlanId ? ratingPlan : await LoadPlanAsync(subscription.PlanId, ct);
        var next = cycle.OpenPeriod(subscription, plan, ended.Index + 1, zone);
        var invoice = cycle.NewInvoice(subscription, customer.Currency, InvoiceKind.Cycle, next.PeriodStart, next.PeriodEnd);
        usage.AddUsageLines(invoice, charges, ended);
        cycle.AddAdvanceLines(invoice, plan, subscription.Quantity, next.PeriodStart, next.PeriodEnd);
        await cycle.SaveAndFinalizeAsync(invoice, ct);
    }

    private async Task<Plan> LoadPlanAsync(Guid planId, CancellationToken ct) =>
        await db.PlanWithItemsAsync(planId, ct) ?? throw new InvalidOperationException($"Plan {planId} does not exist.");
    }
}
