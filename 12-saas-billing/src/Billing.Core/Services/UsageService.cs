using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Services;

public sealed record UsageEventInput(string EventKey, Guid SubscriptionId, string MeterCode, long Quantity, DateTimeOffset OccurredAt);

/// <summary>Outcome of one event in a usage batch: <c>accepted</c>, <c>duplicate</c> or <c>rejected</c> with a reason.</summary>
public sealed record UsageEventResult(string EventKey, Guid SubscriptionId, string Status, string? Reason);

public sealed record UsageBatchResult(IReadOnlyList<UsageEventResult> Results);

public sealed record UsageMeterSummary(string MeterCode, MeterAggregation Aggregation, long BilledQuantity, long UnbilledQuantity);

public sealed record UsageSummary(Guid SubscriptionId, int PeriodIndex, DateOnly PeriodStart, DateOnly PeriodEnd, IReadOnlyList<UsageMeterSummary> Meters);

/// <summary>Accepts metered usage and reports usage totals.</summary>
public sealed class UsageService(BillingDbContext db, TimeProvider clock, BillingSettings settings, ILogger<UsageService> logger)
{
    public static readonly TimeSpan MaxFutureSkew = TimeSpan.FromMinutes(5);

    public static class Reasons
    {
        public const string UnknownSubscription = "unknown_subscription";
        public const string UnknownMeter = "unknown_meter";
        public const string InFuture = "in_future";
        public const string TooOld = "too_old";
        public const string BeforeBillingStart = "before_billing_start";
        public const string SubscriptionEnded = "subscription_ended";
        public const string KeyConflict = "key_conflict";
    }

    /// <summary>Stores the valid events of the batch and returns one result per event in request order.</summary>
    public Task<UsageBatchResult> IngestAsync(IReadOnlyList<UsageEventInput> events, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var now = clock.GetUtcNow();
                var subscriptionIds = events.Select(e => e.SubscriptionId).Distinct().ToArray();
                var subscriptions = (await db.Subscriptions
                        .FromSql($"SELECT * FROM subscriptions WHERE id = ANY({subscriptionIds}) ORDER BY id FOR SHARE")
                        .AsNoTracking()
                        .ToListAsync(ct))
                    .ToDictionary(s => s.Id);

                var customerIds = subscriptions.Values.Select(s => s.CustomerId).Distinct().ToList();
                var zones = (await db.Customers.AsNoTracking()
                        .Where(c => customerIds.Contains(c.Id))
                        .Select(c => new { c.Id, c.Timezone })
                        .ToListAsync(ct))
                    .ToDictionary(c => c.Id, c => BillingCalendar.FindZone(c.Timezone));

                var productIds = subscriptions.Values.Select(s => s.ProductId).Distinct().ToList();
                var soldMeters = (await (
                        from item in db.PlanItems
                        join plan in db.Plans on item.PlanId equals plan.Id
                        where item.Kind == PlanItemKind.Usage && productIds.Contains(plan.ProductId)
                        select new { plan.ProductId, item.MeterCode })
                        .Distinct()
                        .ToListAsync(ct))
                    .Select(x => (x.ProductId, x.MeterCode!))
                    .ToHashSet();

                var results = new List<UsageEventResult>(events.Count);
                foreach (var input in events)
                {
                    var occurredAt = TruncateToMicroseconds(input.OccurredAt);
                    var rejection = Check(input, occurredAt, now, subscriptions, zones, soldMeters);
                    if (rejection is not null)
                    {
                        results.Add(new UsageEventResult(input.EventKey, input.SubscriptionId, "rejected", rejection));
                        continue;
                    }

                    results.Add(await StoreAsync(input, occurredAt, now, ct));
                }

                logger.LogInformation(
                    "Usage batch of {Count} events: {Accepted} accepted, {Duplicates} duplicates, {Rejected} rejected",
                    results.Count,
                    results.Count(r => r.Status == "accepted"),
                    results.Count(r => r.Status == "duplicate"),
                    results.Count(r => r.Status == "rejected"));
                return new UsageBatchResult(results);
            },
            ct);

    /// <summary>Returns the billed and unbilled totals per meter for a period of the subscription.</summary>
    public async Task<UsageSummary> SummaryAsync(Guid subscriptionId, int? periodIndex, CancellationToken ct)
    {
        var subscription = await db.Subscriptions.AsNoTracking().SingleOrDefaultAsync(s => s.Id == subscriptionId, ct)
            ?? throw DomainException.NotFound("Subscription");
        var index = periodIndex ?? subscription.PeriodIndex;
        var period = await db.SubscriptionPeriods.AsNoTracking()
            .SingleOrDefaultAsync(p => p.SubscriptionId == subscriptionId && p.Index == index, ct)
            ?? throw DomainException.NotFound("Billing period");

        var timezone = await db.Customers.Where(c => c.Id == subscription.CustomerId).Select(c => c.Timezone).SingleAsync(ct);
        var zone = BillingCalendar.FindZone(timezone);
        var startsAt = BillingCalendar.StartOfDay(period.PeriodStart, zone);
        var endsAt = BillingCalendar.StartOfDay(period.PeriodEnd, zone);

        var billed = await db.UsageEvents.AsNoTracking()
            .Where(e => e.BilledPeriodId == period.Id)
            .Select(e => new { e.MeterCode, e.Quantity })
            .ToListAsync(ct);
        var unbilled = await db.UsageEvents.AsNoTracking()
            .Where(e => e.SubscriptionId == subscriptionId && e.BilledPeriodId == null && e.OccurredAt >= startsAt && e.OccurredAt < endsAt)
            .Select(e => new { e.MeterCode, e.Quantity })
            .ToListAsync(ct);

        var codes = billed.Select(e => e.MeterCode).Concat(unbilled.Select(e => e.MeterCode)).Distinct().ToList();
        var meters = await db.Meters.AsNoTracking().Where(m => codes.Contains(m.Code)).OrderBy(m => m.Code).ToListAsync(ct);
        var summaries = meters
            .Select(m => new UsageMeterSummary(
                m.Code,
                m.Aggregation,
                UsageAggregation.Aggregate(m.Aggregation, billed.Where(e => e.MeterCode == m.Code).Select(e => e.Quantity)),
                UsageAggregation.Aggregate(m.Aggregation, unbilled.Where(e => e.MeterCode == m.Code).Select(e => e.Quantity))))
            .ToList();
        return new UsageSummary(subscriptionId, period.Index, period.PeriodStart, period.PeriodEnd, summaries);
    }

    private string? Check(
        UsageEventInput input,
        DateTimeOffset occurredAt,
        DateTimeOffset now,
        IReadOnlyDictionary<Guid, Subscription> subscriptions,
        IReadOnlyDictionary<Guid, TimeZoneInfo> zones,
        HashSet<(Guid ProductId, string MeterCode)> soldMeters)
    {
        if (!subscriptions.TryGetValue(input.SubscriptionId, out var subscription))
        {
            return Reasons.UnknownSubscription;
        }

        if (!soldMeters.Contains((subscription.ProductId, input.MeterCode)))
        {
            return Reasons.UnknownMeter;
        }

        if (occurredAt > now + MaxFutureSkew)
        {
            return Reasons.InFuture;
        }

        if (occurredAt < now - settings.UsageMaxAge)
        {
            return Reasons.TooOld;
        }

        var zone = zones[subscription.CustomerId];
        if (occurredAt < BillingCalendar.StartOfDay(subscription.AnchorDate, zone))
        {
            return Reasons.BeforeBillingStart;
        }

        var ended = subscription.Status == SubscriptionStatus.Canceled && subscription.FinalSealedAt is not null;
        if (ended || (subscription.EndedOn is { } endedOn && occurredAt >= BillingCalendar.StartOfDay(endedOn, zone)))
        {
            return Reasons.SubscriptionEnded;
        }

        if (subscription.CancelAtPeriodEnd
            && subscription.CurrentPeriodEnd is { } lastPeriodEnd
            && occurredAt >= BillingCalendar.StartOfDay(lastPeriodEnd, zone))
        {
            return Reasons.SubscriptionEnded;
        }

        return null;
    }

    private async Task<UsageEventResult> StoreAsync(UsageEventInput input, DateTimeOffset occurredAt, DateTimeOffset now, CancellationToken ct)
    {
        var id = Ids.New(clock);
        var inserted = await db.Database.SqlQuery<Guid>(
            $"""
            INSERT INTO usage_events (id, subscription_id, meter_code, event_key, quantity, occurred_at, received_at, billed_period_id, late)
            VALUES ({id}, {input.SubscriptionId}, {input.MeterCode}, {input.EventKey}, {input.Quantity}, {occurredAt}, {now}, NULL, false)
            ON CONFLICT (subscription_id, event_key) DO NOTHING
            RETURNING id AS "Value"
            """).ToListAsync(ct);
        if (inserted.Count == 1)
        {
            return new UsageEventResult(input.EventKey, input.SubscriptionId, "accepted", null);
        }

        var existing = await db.UsageEvents.AsNoTracking()
            .SingleAsync(e => e.SubscriptionId == input.SubscriptionId && e.EventKey == input.EventKey, ct);
        var same = existing.MeterCode == input.MeterCode && existing.Quantity == input.Quantity && existing.OccurredAt == occurredAt;
        return same
            ? new UsageEventResult(input.EventKey, input.SubscriptionId, "duplicate", null)
            : new UsageEventResult(input.EventKey, input.SubscriptionId, "rejected", Reasons.KeyConflict);
    }

    private static DateTimeOffset TruncateToMicroseconds(DateTimeOffset value) =>
        new(value.UtcTicks - (value.UtcTicks % 10), TimeSpan.Zero);
}
