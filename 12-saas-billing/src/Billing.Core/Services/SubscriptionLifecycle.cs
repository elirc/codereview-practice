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

public enum ChangeTiming
{
    Immediate,
    NextPeriod,
}

public sealed record ChangePreviewLine(InvoiceLineKind Kind, string Description, long Quantity, long AmountMinor);

/// <summary>What a plan or quantity change would do: when it applies and the proration lines it would invoice.</summary>
public sealed record ChangePreview(
    Guid SubscriptionId,
    string PlanCode,
    int Quantity,
    ChangeTiming Timing,
    DateOnly? EffectiveOn,
    IReadOnlyList<ChangePreviewLine> Lines,
    long SubtotalMinor,
    long TaxMinor,
    long TotalMinor);

/// <summary>Plan and quantity changes, cancellation and resumption of subscriptions.</summary>
public sealed class SubscriptionLifecycle(
    BillingDbContext db,
    TimeProvider clock,
    SubscriptionCycle cycle,
    UsageRating usage,
    InvoiceFinalizer finalizer,
    EventRecorder events,
    ViewLoader views,
    ILogger<SubscriptionLifecycle> logger)
{
    private enum ChangeKind
    {
        Trial,
        Increase,
        Decrease,
        Equal,
    }

    private sealed record PlannedChange(
        Plan CurrentPlan,
        Plan NewPlan,
        int NewQuantity,
        DateOnly Today,
        ChangeKind Kind,
        IReadOnlyList<ProrationLine> Lines);

    /// <summary>
    /// Changes the plan and/or quantity: at once while trialing or when the recurring amount does not drop (with a
    /// proration invoice when it rises), otherwise as a pending change for the next boundary.
    /// </summary>
    public Task<SubscriptionView> ChangeAsync(Guid subscriptionId, string? planCode, int? quantity, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var subscription = await db.LockSubscriptionAsync(subscriptionId, ct) ?? throw DomainException.NotFound("Subscription");
                var change = await PlanChangeAsync(subscription, planCode, quantity, ct);
                var previous = new SubscriptionSnapshot(change.CurrentPlan.Code, subscription.Quantity, subscription.Status);

                switch (change.Kind)
                {
                    case ChangeKind.Increase:
                        await UpgradeAsync(subscription, change, ct);
                        break;

                    case ChangeKind.Decrease:
                        subscription.PendingPlanId = change.NewPlan.Id;
                        subscription.PendingQuantity = change.NewQuantity;
                        logger.LogInformation(
                            "Subscription {SubscriptionId} scheduled a change to {PlanCode} x{Quantity} at the next boundary",
                            subscription.Id,
                            change.NewPlan.Code,
                            change.NewQuantity);
                        break;

                    default:
                        ApplyNow(subscription, change.NewPlan, change.NewQuantity);
                        break;
                }

                await events.SubscriptionUpdatedAsync(subscription, previous, ct);
                return await views.SubscriptionAsync(subscription, ct);
            },
            ct);

    /// <summary>
    /// Returns what <see cref="ChangeAsync"/> would do with the same plan and quantity: when the change applies and,
    /// for an increase, the proration lines and totals of its invoice. Nothing is stored.
    /// </summary>
    public async Task<ChangePreview> PreviewChangeAsync(Guid subscriptionId, string? planCode, int? quantity, CancellationToken ct)
    {
        var subscription = await db.Subscriptions.AsNoTracking().SingleOrDefaultAsync(s => s.Id == subscriptionId, ct)
            ?? throw DomainException.NotFound("Subscription");
        var change = await PlanChangeAsync(subscription, planCode, quantity, ct);

        var lines = change.Lines
            .Select(l => new ChangePreviewLine(LineKind(l), l.Description, l.Quantity, l.AmountMinor))
            .ToList();
        var subtotal = Proration.Total(change.Lines);
        var tax = 0L;
        if (lines.Count > 0)
        {
            var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == subscription.CustomerId, ct);
            tax = TaxMath.LineTax(subtotal, await finalizer.TaxRateAsync(customer, change.Today, ct));
        }

        var timing = change.Kind == ChangeKind.Decrease ? ChangeTiming.NextPeriod : ChangeTiming.Immediate;
        var effectiveOn = timing == ChangeTiming.NextPeriod ? subscription.CurrentPeriodEnd : change.Today;
        return new ChangePreview(
            subscription.Id,
            change.NewPlan.Code,
            change.NewQuantity,
            timing,
            effectiveOn,
            lines,
            subtotal,
            tax,
            subtotal + tax);
    }

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

    /// <summary>Checks that the subscription may change to the plan and quantity and works out how the change applies.</summary>
    private async Task<PlannedChange> PlanChangeAsync(Subscription subscription, string? planCode, int? quantity, CancellationToken ct)
    {
        if (subscription.Status == SubscriptionStatus.Canceled || subscription.CancelAtPeriodEnd)
        {
            throw DomainException.InvalidState("A canceled or cancelling subscription cannot be changed.");
        }

        var currentPlan = await LoadPlanAsync(subscription.PlanId, ct);
        var newPlan = planCode is null || planCode == currentPlan.Code
            ? currentPlan
            : await db.PlanWithItemsAsync(planCode, ct) ?? throw DomainException.NotFound("Plan");
        EnsureCompatible(currentPlan, newPlan);

        var newQuantity = quantity ?? subscription.Quantity;
        var today = DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime);
        if (subscription.Status == SubscriptionStatus.Trialing)
        {
            return new PlannedChange(currentPlan, newPlan, newQuantity, today, ChangeKind.Trial, []);
        }

        if (today >= subscription.CurrentPeriodEnd)
        {
            throw DomainException.Conflict(ErrorCodes.RenewalInProgress, "The current period has ended and is being renewed.");
        }

        var currentCharges = currentPlan.AdvanceCharges(subscription.Quantity);
        var newCharges = newPlan.AdvanceCharges(newQuantity);
        var currentRecurring = Proration.Recurring(currentCharges);
        var newRecurring = Proration.Recurring(newCharges);
        if (newRecurring < currentRecurring)
        {
            return new PlannedChange(currentPlan, newPlan, newQuantity, today, ChangeKind.Decrease, []);
        }

        if (newRecurring == currentRecurring)
        {
            return new PlannedChange(currentPlan, newPlan, newQuantity, today, ChangeKind.Equal, []);
        }

        var periodEnd = subscription.CurrentPeriodEnd!.Value;
        var remainingDays = BillingCalendar.DaysBetween(today, periodEnd);
        var periodDays = BillingCalendar.DaysBetween(subscription.CurrentPeriodStart!.Value, periodEnd);
        var lines = Proration.Lines(currentCharges, newCharges, remainingDays, periodDays);
        return new PlannedChange(currentPlan, newPlan, newQuantity, today, ChangeKind.Increase, lines);
    }

    private async Task UpgradeAsync(Subscription subscription, PlannedChange change, CancellationToken ct)
    {
        var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == subscription.CustomerId, ct);
        var zone = BillingCalendar.FindZone(customer.Timezone);
        var periodEnd = subscription.CurrentPeriodEnd!.Value;
        var period = await db.SubscriptionPeriods
            .SingleAsync(p => p.SubscriptionId == subscription.Id && p.Index == subscription.PeriodIndex, ct);

        var invoice = cycle.NewInvoice(subscription, customer.Currency, InvoiceKind.Proration, change.Today, periodEnd);
        foreach (var line in change.Lines)
        {
            invoice.AddLine(clock, LineKind(line), line.Description, line.Quantity, line.AmountMinor, line.PlanItemId, change.Today, periodEnd);
        }

        var periodPlan = await LoadPlanAsync(period.PlanId, ct);
        var keptMeters = change.NewPlan.UsageItems().Select(i => i.MeterCode!).ToHashSet();
        var droppedMeters = periodPlan.UsageItems().Select(i => i.MeterCode!).Where(m => !keptMeters.Contains(m)).ToList();
        if (droppedMeters.Count > 0)
        {
            var sealedUsage = await usage.SealAsync(period, zone, clock.GetUtcNow(), droppedMeters, ct);
            usage.AddUsageLines(invoice, await usage.RateAsync(sealedUsage, periodPlan, ct), period);
        }

        ApplyNow(subscription, change.NewPlan, change.NewQuantity);
        period.PlanId = change.NewPlan.Id;
        await cycle.SaveAndFinalizeAsync(invoice, ct);
        logger.LogInformation(
            "Subscription {SubscriptionId} upgraded to {PlanCode} x{Quantity} with proration invoice {InvoiceId}",
            subscription.Id,
            change.NewPlan.Code,
            change.NewQuantity,
            invoice.Id);
    }

    private static InvoiceLineKind LineKind(ProrationLine line) =>
        line.IsCredit ? InvoiceLineKind.ProrationCredit : InvoiceLineKind.ProrationCharge;

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
