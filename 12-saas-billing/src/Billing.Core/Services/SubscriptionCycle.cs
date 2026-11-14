using Billing.Core.Data;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Billing.Core.Services;

/// <summary>Plan queries used when billing subscriptions.</summary>
public static class PlanQueries
{
    /// <summary>Loads a plan with its items and tiers, without tracking.</summary>
    public static Task<Plan?> PlanWithItemsAsync(this BillingDbContext db, Guid id, CancellationToken ct) =>
        db.Plans.AsNoTracking().Include(p => p.Items).ThenInclude(i => i.Tiers).SingleOrDefaultAsync(p => p.Id == id, ct);

    /// <summary>Loads a plan by code with its items and tiers, without tracking.</summary>
    public static Task<Plan?> PlanWithItemsAsync(this BillingDbContext db, string code, CancellationToken ct) =>
        db.Plans.AsNoTracking().Include(p => p.Items).ThenInclude(i => i.Tiers).SingleOrDefaultAsync(p => p.Code == code, ct);

    /// <summary>Returns the advance charges of the plan at the quantity, in item order.</summary>
    public static IReadOnlyList<AdvanceCharge> AdvanceCharges(this Plan plan, int quantity) =>
        plan.Items
            .Where(i => i.Kind is PlanItemKind.Flat or PlanItemKind.PerSeat)
            .OrderBy(i => i.Position)
            .Select(i => new AdvanceCharge(i.Id, i.Kind, i.Name, i.UnitAmountMinor ?? 0, quantity))
            .ToList();

    /// <summary>Returns the usage items of the plan, in item order.</summary>
    public static IReadOnlyList<PlanItem> UsageItems(this Plan plan) =>
        plan.Items.Where(i => i.Kind == PlanItemKind.Usage).OrderBy(i => i.Position).ToList();
}

/// <summary>Period and invoice steps shared by subscription creation, the billing run and plan changes.</summary>
public sealed class SubscriptionCycle(BillingDbContext db, TimeProvider clock, BillingSettings settings, InvoiceFinalizer finalizer)
{
    /// <summary>
    /// Adds period <paramref name="index"/> of the subscription, rated by <paramref name="plan"/>, and moves the
    /// subscription's current period and next billing instant to it.
    /// </summary>
    public SubscriptionPeriod OpenPeriod(Subscription subscription, Plan plan, int index, TimeZoneInfo zone)
    {
        var dates = BillingCalendar.Period(subscription.AnchorDate, plan.Interval, index);
        var period = new SubscriptionPeriod
        {
            Id = Ids.New(clock),
            SubscriptionId = subscription.Id,
            Index = index,
            PeriodStart = dates.Start,
            PeriodEnd = dates.End,
            PlanId = plan.Id,
        };
        db.SubscriptionPeriods.Add(period);

        subscription.PeriodIndex = index;
        subscription.CurrentPeriodStart = dates.Start;
        subscription.CurrentPeriodEnd = dates.End;
        subscription.NextBillingAt = BoundaryDueAt(dates.End, zone);
        return period;
    }

    /// <summary>Returns the instant at which the boundary at the end of a period is billed.</summary>
    public DateTimeOffset BoundaryDueAt(DateOnly periodEnd, TimeZoneInfo zone) =>
        BillingCalendar.StartOfDay(periodEnd, zone) + settings.UsageGrace;

    /// <summary>Adds a new draft invoice for the subscription to the context and returns it.</summary>
    public Invoice NewInvoice(Subscription subscription, string currency, InvoiceKind kind, DateOnly periodStart, DateOnly periodEnd)
    {
        var invoice = InvoiceDrafts.New(clock, subscription.CustomerId, currency, kind, subscription.Id, periodStart, periodEnd);
        db.Invoices.Add(invoice);
        return invoice;
    }

    /// <summary>Adds the plan's flat and per-seat charges for the period as advance lines.</summary>
    public void AddAdvanceLines(Invoice invoice, Plan plan, int quantity, DateOnly periodStart, DateOnly periodEnd)
    {
        foreach (var charge in plan.AdvanceCharges(quantity))
        {
            var kind = charge.Kind == PlanItemKind.PerSeat ? InvoiceLineKind.Seats : InvoiceLineKind.Flat;
            invoice.AddLine(clock, kind, charge.Name, charge.BilledQuantity, charge.AmountMinor, charge.PlanItemId, periodStart, periodEnd);
        }
    }

    /// <summary>Saves the draft invoice and its lines, then finalises it.</summary>
    public async Task SaveAndFinalizeAsync(Invoice invoice, CancellationToken ct)
    {
        await db.SaveChangesAsync(ct);
        await finalizer.FinalizeAsync(invoice, ct);
    }
}
