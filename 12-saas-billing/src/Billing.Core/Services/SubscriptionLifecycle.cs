using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Views;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Services;

public enum CancelMode
{
    PeriodEnd,
    Immediate,
}

/// <summary>Plan and quantity changes, cancellation and resumption of subscriptions.</summary>
public sealed class SubscriptionLifecycle(
    BillingDbContext db,
    TimeProvider clock,
    SubscriptionCycle cycle,
    UsageRating usage,
    EventRecorder events,
    ViewLoader views,
    ILogger<SubscriptionLifecycle> logger)
{
    /// <summary>
    /// Changes the plan and/or quantity: at once while trialing or when the recurring amount does not drop (with a
    /// proration invoice when it rises), otherwise as a pending change for the next boundary.
    /// </summary>
    public Task<SubscriptionView> ChangeAsync(Guid subscriptionId, string? planCode, int? quantity, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var subscription = await db.LockSubscriptionAsync(subscriptionId, ct) ?? throw DomainException.NotFound("Subscription");
                if (subscription.Status == SubscriptionStatus.Canceled || subscription.CancelAtPeriodEnd)
                {
                    throw DomainException.InvalidState("A canceled or cancelling subscription cannot be changed.");
                }

                var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == subscription.CustomerId, ct);
                var zone = BillingCalendar.FindZone(customer.Timezone);
                var today = BillingCalendar.Today(clock.GetUtcNow(), zone);

                var currentPlan = await LoadPlanAsync(subscription.PlanId, ct);
                var newPlan = planCode is null || planCode == currentPlan.Code
                    ? currentPlan
                    : await db.PlanWithItemsAsync(planCode, ct) ?? throw DomainException.NotFound("Plan");
                EnsureCompatible(currentPlan, newPlan);

                var newQuantity = quantity ?? subscription.Quantity;
                var previous = new SubscriptionSnapshot(currentPlan.Code, subscription.Quantity, subscription.Status);

                if (subscription.Status == SubscriptionStatus.Trialing)
                {
                    ApplyNow(subscription, newPlan, newQuantity);
                    await events.SubscriptionUpdatedAsync(subscription, previous, ct);
                    return await views.SubscriptionAsync(subscription, ct);
                }

                if (today >= subscription.CurrentPeriodEnd)
                {
                    throw DomainException.Conflict(ErrorCodes.RenewalInProgress, "The current period has ended and is being renewed.");
                }

                var currentCharges = currentPlan.AdvanceCharges(subscription.Quantity);
                var newCharges = newPlan.AdvanceCharges(newQuantity);
                var currentRecurring = Proration.Recurring(currentCharges);
                var newRecurring = Proration.Recurring(newCharges);

                if (newRecurring > currentRecurring)
                {
                    await UpgradeAsync(subscription, customer, zone, today, newPlan, newQuantity, currentCharges, newCharges, ct);
                }
                else if (newRecurring < currentRecurring)
                {
                    subscription.PendingPlanId = newPlan.Id;
                    subscription.PendingQuantity = newQuantity;
                    logger.LogInformation(
                        "Subscription {SubscriptionId} scheduled a change to {PlanCode} x{Quantity} at the next boundary",
                        subscription.Id,
                        newPlan.Code,
                        newQuantity);
                }
                else
                {
                    ApplyNow(subscription, newPlan, newQuantity);
                }

                await events.SubscriptionUpdatedAsync(subscription, previous, ct);
                return await views.SubscriptionAsync(subscription, ct);
            },
            ct);

    /// <summary>Cancels the subscription at the end of its period or at once.</summary>
    public Task<SubscriptionView> CancelAsync(Guid subscriptionId, CancelMode mode, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var subscription = await db.LockSubscriptionAsync(subscriptionId, ct) ?? throw DomainException.NotFound("Subscription");
                if (subscription.Status == SubscriptionStatus.Canceled)
                {
                    throw DomainException.InvalidState("The subscription is already canceled.");
                }

                if (mode == CancelMode.Immediate || subscription.Status == SubscriptionStatus.Trialing)
                {
                    await CancelNowAsync(subscription, CancelReason.Requested, ct);
                }
                else if (!subscription.CancelAtPeriodEnd)
                {
                    var previous = await SnapshotAsync(subscription, ct);
                    subscription.CancelAtPeriodEnd = true;
                    await events.SubscriptionUpdatedAsync(subscription, previous, ct);
                }

                return await views.SubscriptionAsync(subscription, ct);
            },
            ct);

    /// <summary>Withdraws a cancellation scheduled for the end of the period.</summary>
    public Task<SubscriptionView> ResumeAsync(Guid subscriptionId, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var subscription = await db.LockSubscriptionAsync(subscriptionId, ct) ?? throw DomainException.NotFound("Subscription");
                if (subscription.Status == SubscriptionStatus.Canceled || !subscription.CancelAtPeriodEnd)
                {
                    throw DomainException.InvalidState("Only a subscription scheduled to cancel at period end can be resumed.");
                }

                var previous = await SnapshotAsync(subscription, ct);
                subscription.CancelAtPeriodEnd = false;
                await events.SubscriptionUpdatedAsync(subscription, previous, ct);
                return await views.SubscriptionAsync(subscription, ct);
            },
            ct);

    /// <summary>
    /// Ends a subscription now: marks it canceled as of now, seals and rates its unbilled usage
    /// into the current period, finalises a final invoice when that produces lines, and records the event.
    /// </summary>
    public async Task CancelNowAsync(Subscription subscription, CancelReason reason, CancellationToken ct)
    {
        var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == subscription.CustomerId, ct);
        var zone = BillingCalendar.FindZone(customer.Timezone);
        var now = clock.GetUtcNow();
        var wasTrialing = subscription.Status == SubscriptionStatus.Trialing;

        subscription.Status = SubscriptionStatus.Canceled;
        subscription.CanceledAt = now;
        subscription.EndedOn = BillingCalendar.Today(now, zone);
        subscription.FinalSealedAt = now;
        subscription.CancelReason = reason;
        subscription.NextBillingAt = null;
        subscription.PendingPlanId = null;
        subscription.PendingQuantity = null;

        if (!wasTrialing)
        {
            var period = await db.SubscriptionPeriods
                .SingleAsync(p => p.SubscriptionId == subscription.Id && p.Index == subscription.PeriodIndex, ct);
            var sealedUsage = await usage.SealAsync(period, zone, now, null, ct);
            var charges = await usage.RateAsync(sealedUsage, await LoadPlanAsync(period.PlanId, ct), ct);
            if (charges.Count > 0)
            {
                var invoice = cycle.NewInvoice(subscription, customer.Currency, InvoiceKind.Final, period.PeriodStart, period.PeriodEnd);
                usage.AddUsageLines(invoice, charges, period);
                await cycle.SaveAndFinalizeAsync(invoice, ct);
            }
        }

        logger.LogInformation("Subscription {SubscriptionId} canceled ({Reason})", subscription.Id, reason);
        await events.SubscriptionAsync(
            EventTypes.SubscriptionCanceled,
            subscription,
            new Dictionary<string, object?> { ["reason"] = reason },
            ct);
    }

    private async Task UpgradeAsync(
        Subscription subscription,
        Customer customer,
        TimeZoneInfo zone,
        DateOnly today,
        Plan newPlan,
        int newQuantity,
        IReadOnlyList<AdvanceCharge> currentCharges,
        IReadOnlyList<AdvanceCharge> newCharges,
        CancellationToken ct)
    {
        var periodEnd = subscription.CurrentPeriodEnd!.Value;
        var periodStart = subscription.CurrentPeriodStart!.Value;
        var remainingDays = BillingCalendar.DaysBetween(today, periodEnd);
        var periodDays = BillingCalendar.DaysBetween(periodStart, periodEnd);
        var period = await db.SubscriptionPeriods
            .SingleAsync(p => p.SubscriptionId == subscription.Id && p.Index == subscription.PeriodIndex, ct);

        var invoice = cycle.NewInvoice(subscription, customer.Currency, InvoiceKind.Proration, today, periodEnd);
        foreach (var line in Proration.Lines(currentCharges, newCharges, remainingDays, periodDays))
        {
            invoice.AddLine(
                clock,
                line.IsCredit ? InvoiceLineKind.ProrationCredit : InvoiceLineKind.ProrationCharge,
                line.IsCredit ? $"Unused time on {line.Name}" : $"Remaining time on {line.Name}",
                line.Quantity,
                line.AmountMinor,
                line.PlanItemId,
                today,
                periodEnd);
        }

        var periodPlan = await LoadPlanAsync(period.PlanId, ct);
        var keptMeters = newPlan.UsageItems().Select(i => i.MeterCode!).ToHashSet();
        var droppedMeters = periodPlan.UsageItems().Select(i => i.MeterCode!).Where(m => !keptMeters.Contains(m)).ToList();
        if (droppedMeters.Count > 0)
        {
            var sealedUsage = await usage.SealAsync(period, zone, clock.GetUtcNow(), droppedMeters, ct);
            usage.AddUsageLines(invoice, await usage.RateAsync(sealedUsage, periodPlan, ct), period);
        }

        ApplyNow(subscription, newPlan, newQuantity);
        period.PlanId = newPlan.Id;
        await cycle.SaveAndFinalizeAsync(invoice, ct);
        logger.LogInformation(
            "Subscription {SubscriptionId} upgraded to {PlanCode} x{Quantity} with proration invoice {InvoiceId}",
            subscription.Id,
            newPlan.Code,
            newQuantity,
            invoice.Id);
    }

    private static void ApplyNow(Subscription subscription, Plan plan, int quantity)
    {
        subscription.PlanId = plan.Id;
        subscription.Quantity = quantity;
        subscription.PendingPlanId = null;
        subscription.PendingQuantity = null;
    }

    private static void EnsureCompatible(Plan current, Plan next)
    {
        if (next.Id == current.Id)
        {
            return;
        }

        if (!next.Active || next.ProductId != current.ProductId || next.Interval != current.Interval || next.Currency != current.Currency)
        {
            throw DomainException.Unprocessable(
                ErrorCodes.PlanIncompatible,
                "The new plan must be active and belong to the same product with the same interval and currency.");
        }
    }

    private async Task<SubscriptionSnapshot> SnapshotAsync(Subscription subscription, CancellationToken ct)
    {
        var code = await db.Plans.Where(p => p.Id == subscription.PlanId).Select(p => p.Code).SingleAsync(ct);
        return new SubscriptionSnapshot(code, subscription.Quantity, subscription.Status);
    }

    private async Task<Plan> LoadPlanAsync(Guid planId, CancellationToken ct) =>
        await db.PlanWithItemsAsync(planId, ct) ?? throw new InvalidOperationException($"Plan {planId} does not exist.");
}
