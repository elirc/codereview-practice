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
                var subscriptionIds = events.Select(e => e.SubscriptionId).Distinct().ToList();
                var targets = (await (
                        from subscription in db.Subscriptions.AsNoTracking()
                        join customer in db.Customers.AsNoTracking() on subscription.CustomerId equals customer.Id
                        where subscriptionIds.Contains(subscription.Id)
                        select new { Subscription = subscription, customer.Timezone })
                        .ToListAsync(ct))
                    .ToDictionary(x => x.Subscription.Id, x => new UsageTarget(x.Subscription, BillingCalendar.FindZone(x.Timezone)));

                var productIds = targets.Values.Select(t => t.Subscription.ProductId).Distinct().ToList();
                var soldMeters = (await (
                        from item in db.PlanItems
                        join plan in db.Plans on item.PlanId equals plan.Id
                        where item.Kind == PlanItemKind.Usage && productIds.Contains(plan.ProductId)
                        select new { plan.ProductId, item.MeterCode })
                        .Distinct()
                        .ToListAsync(ct))
                    .Select(x => (x.ProductId, x.MeterCode!))
                    .ToHashSet();

                var results = new UsageEventResult[events.Count];
                var batch = new List<PendingEvent>();
                var byKey = new Dictionary<string, PendingEvent>(StringComparer.Ordinal);
                for (var i = 0; i < events.Count; i++)
                {
                    var input = events[i];
                    var occurredAt = TruncateToMicroseconds(input.OccurredAt);
                    var rejection = Check(input, occurredAt, now, targets, soldMeters);
                    if (rejection is not null)
                    {
                        results[i] = new UsageEventResult(input.EventKey, input.SubscriptionId, "rejected", rejection);
                        continue;
                    }

                    if (byKey.TryGetValue(input.EventKey, out var first))
                    {
                        first.Repeats.Add((i, input, occurredAt));
                        continue;
                    }

                    var pending = new PendingEvent(i, input, occurredAt);
                    byKey.Add(input.EventKey, pending);
                    batch.Add(pending);
                }

                await StoreAsync(batch, now, ct);
                foreach (var pending in batch)
                {
                    results[pending.Index] = pending.Inserted
                        ? new UsageEventResult(pending.Input.EventKey, pending.Input.SubscriptionId, "accepted", null)
                        : Compare(pending.Stored!, pending.Input, pending.OccurredAt);
                    var stored = pending.Stored ?? new StoredUsage(pending.Input.MeterCode, pending.Input.Quantity, pending.OccurredAt);
                    foreach (var (index, input, occurredAt) in pending.Repeats)
                    {
                        results[index] = Compare(stored, input, occurredAt);
                    }
                }

                logger.LogInformation(
                    "Usage batch of {Count} events: {Accepted} accepted, {Duplicates} duplicates, {Rejected} rejected",
                    results.Length,
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
        IReadOnlyDictionary<Guid, UsageTarget> targets,
        HashSet<(Guid ProductId, string MeterCode)> soldMeters)
    {
        if (!targets.TryGetValue(input.SubscriptionId, out var target))
        {
            return Reasons.UnknownSubscription;
        }

        var (subscription, zone) = target;

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

    /// <summary>
    /// Inserts the events in one statement, marks the ones that were inserted and attaches the stored row to
    /// the ones whose key was already taken.
    /// </summary>
    private async Task StoreAsync(IReadOnlyList<PendingEvent> batch, DateTimeOffset now, CancellationToken ct)
    {
        if (batch.Count == 0)
        {
            return;
        }

        var ids = batch.Select(_ => Ids.New(clock)).ToArray();
        var subscriptionIds = batch.Select(p => p.Input.SubscriptionId).ToArray();
        var meterCodes = batch.Select(p => p.Input.MeterCode).ToArray();
        var eventKeys = batch.Select(p => p.Input.EventKey).ToArray();
        var quantities = batch.Select(p => p.Input.Quantity).ToArray();
        var occurredAts = batch.Select(p => p.OccurredAt).ToArray();

        var inserted = (await db.Database.SqlQuery<UsageKey>(
                $"""
                INSERT INTO usage_events (id, subscription_id, meter_code, event_key, quantity, occurred_at, received_at, billed_period_id, late)
                SELECT e.id, e.subscription_id, e.meter_code, e.event_key, e.quantity, e.occurred_at, {now}, NULL::uuid, false
                FROM unnest({ids}, {subscriptionIds}, {meterCodes}, {eventKeys}, {quantities}, {occurredAts})
                    AS e (id, subscription_id, meter_code, event_key, quantity, occurred_at)
                ON CONFLICT (subscription_id, event_key) DO NOTHING
                RETURNING subscription_id AS "SubscriptionId", event_key AS "EventKey"
                """).ToListAsync(ct))
            .Select(k => (k.SubscriptionId, k.EventKey))
            .ToHashSet();

        var taken = batch.Where(p => !inserted.Contains((p.Input.SubscriptionId, p.Input.EventKey))).ToList();
        foreach (var pending in batch)
        {
            pending.Inserted = inserted.Contains((pending.Input.SubscriptionId, pending.Input.EventKey));
        }

        if (taken.Count == 0)
        {
            return;
        }

        var takenSubscriptions = taken.Select(p => p.Input.SubscriptionId).ToArray();
        var takenKeys = taken.Select(p => p.Input.EventKey).ToArray();
        var existing = (await db.UsageEvents
                .FromSql(
                    $"""
                    SELECT * FROM usage_events
                    WHERE (subscription_id, event_key) IN (SELECT * FROM unnest({takenSubscriptions}, {takenKeys}))
                    """)
                .AsNoTracking()
                .ToListAsync(ct))
            .ToDictionary(e => (e.SubscriptionId, e.EventKey));
        foreach (var pending in taken)
        {
            var row = existing[(pending.Input.SubscriptionId, pending.Input.EventKey)];
            pending.Stored = new StoredUsage(row.MeterCode, row.Quantity, row.OccurredAt);
        }
    }

    private static UsageEventResult Compare(StoredUsage stored, UsageEventInput input, DateTimeOffset occurredAt)
    {
        var same = stored.MeterCode == input.MeterCode && stored.Quantity == input.Quantity && stored.OccurredAt == occurredAt;
        return same
            ? new UsageEventResult(input.EventKey, input.SubscriptionId, "duplicate", null)
            : new UsageEventResult(input.EventKey, input.SubscriptionId, "rejected", Reasons.KeyConflict);
    }

    private static DateTimeOffset TruncateToMicroseconds(DateTimeOffset value) =>
        new(value.UtcTicks - (value.UtcTicks % 10), TimeSpan.Zero);

    private sealed record UsageTarget(Subscription Subscription, TimeZoneInfo Zone);

    private sealed record StoredUsage(string MeterCode, long Quantity, DateTimeOffset OccurredAt);

    /// <summary>An event of the batch that passed the checks, with any later events of the batch that share its key.</summary>
    private sealed class PendingEvent(int index, UsageEventInput input, DateTimeOffset occurredAt)
    {
        public int Index { get; } = index;

        public UsageEventInput Input { get; } = input;

        public DateTimeOffset OccurredAt { get; } = occurredAt;

        public List<(int Index, UsageEventInput Input, DateTimeOffset OccurredAt)> Repeats { get; } = [];

        public bool Inserted { get; set; }

        public StoredUsage? Stored { get; set; }
    }
}

/// <summary>The key of a stored usage event.</summary>
public sealed class UsageKey
{
    public Guid SubscriptionId { get; set; }

    public string EventKey { get; set; } = string.Empty;
}
