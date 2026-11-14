using Billing.Core.Data;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Billing.Core.Services;

/// <summary>One usage row sealed into a period.</summary>
public sealed class SealedUsage
{
    public string MeterCode { get; set; } = string.Empty;

    public long Quantity { get; set; }
}

/// <summary>The rated usage of one meter in one sealing.</summary>
public sealed record UsageCharge(Guid PlanItemId, string Name, string MeterCode, long Quantity, long AmountMinor);

/// <summary>Seals unbilled usage into a period and prices it with a plan's usage items.</summary>
public sealed class UsageRating(BillingDbContext db, TimeProvider clock)
{
    /// <summary>
    /// Marks every unbilled event of the subscription that occurred before <paramref name="cutoff"/> as billed in
    /// <paramref name="period"/>, flags those that occurred before the period began as late, and returns them.
    /// Only the listed meters are sealed when <paramref name="meterCodes"/> is given.
    /// </summary>
    public async Task<IReadOnlyList<SealedUsage>> SealAsync(
        SubscriptionPeriod period,
        TimeZoneInfo zone,
        DateTimeOffset cutoff,
        IReadOnlyCollection<string>? meterCodes,
        CancellationToken ct)
    {
        var periodStartsAt = BillingCalendar.StartOfDay(period.PeriodStart, zone);
        List<SealedUsage> sealedRows;
        if (meterCodes is null)
        {
            sealedRows = await db.Database.SqlQuery<SealedUsage>(
                $"""
                UPDATE usage_events
                SET billed_period_id = {period.Id}, late = occurred_at < {periodStartsAt}
                WHERE subscription_id = {period.SubscriptionId} AND billed_period_id IS NULL AND occurred_at < {cutoff}
                RETURNING meter_code AS "MeterCode", quantity AS "Quantity"
                """).ToListAsync(ct);
        }
        else
        {
            var codes = meterCodes.ToArray();
            sealedRows = await db.Database.SqlQuery<SealedUsage>(
                $"""
                UPDATE usage_events
                SET billed_period_id = {period.Id}, late = occurred_at < {periodStartsAt}
                WHERE subscription_id = {period.SubscriptionId} AND billed_period_id IS NULL AND occurred_at < {cutoff}
                  AND meter_code = ANY({codes})
                RETURNING meter_code AS "MeterCode", quantity AS "Quantity"
                """).ToListAsync(ct);
        }

        period.UsageSealedAt = clock.GetUtcNow();
        return sealedRows;
    }

    /// <summary>Prices sealed usage with the plan's usage items; meters with no usage produce no charge.</summary>
    public async Task<IReadOnlyList<UsageCharge>> RateAsync(IReadOnlyList<SealedUsage> usage, Plan plan, CancellationToken ct)
    {
        if (usage.Count == 0)
        {
            return [];
        }

        var codes = usage.Select(u => u.MeterCode).Distinct().ToList();
        var aggregations = await db.Meters.AsNoTracking()
            .Where(m => codes.Contains(m.Code))
            .ToDictionaryAsync(m => m.Code, m => m.Aggregation, ct);
        var byMeter = usage.ToLookup(u => u.MeterCode, u => u.Quantity);

        var charges = new List<UsageCharge>();
        foreach (var item in plan.UsageItems())
        {
            var meter = item.MeterCode!;
            if (!byMeter.Contains(meter))
            {
                continue;
            }

            var quantity = UsageAggregation.Aggregate(aggregations[meter], byMeter[meter]);
            if (quantity == 0)
            {
                continue;
            }

            var tiers = item.Tiers.OrderBy(t => t.Position).Select(t => new PriceTierSpec(t.UpTo, t.UnitAmountMinor, t.FlatAmountMinor)).ToList();
            var amount = TierRating.Rate(quantity, item.TierMode!.Value, tiers);
            charges.Add(new UsageCharge(item.Id, item.Name, meter, quantity, amount));
        }

        return charges;
    }

    /// <summary>Adds one usage line per charge, dated with the period the usage was sealed into.</summary>
    public void AddUsageLines(Invoice invoice, IReadOnlyList<UsageCharge> charges, SubscriptionPeriod period)
    {
        foreach (var charge in charges)
        {
            invoice.AddLine(
                clock,
                InvoiceLineKind.Usage,
                charge.Name,
                charge.Quantity,
                charge.AmountMinor,
                charge.PlanItemId,
                period.PeriodStart,
                period.PeriodEnd);
        }
    }
}
