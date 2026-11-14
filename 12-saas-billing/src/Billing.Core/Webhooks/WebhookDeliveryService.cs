using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Webhooks;

public sealed record WebhookDeliveryView(
    Guid Id,
    Guid EventId,
    string EventType,
    Guid EndpointId,
    Guid ObjectId,
    long Sequence,
    WebhookDeliveryStatus Status,
    int Attempts,
    DateTimeOffset NextAttemptAt,
    int? LastStatusCode,
    string? LastError,
    DateTimeOffset? DeliveredAt,
    DateTimeOffset CreatedAt);

/// <summary>Lists webhook deliveries and puts failed ones back in the queue.</summary>
public sealed class WebhookDeliveryService(BillingDbContext db, TimeProvider clock)
{
    public async Task<Page<WebhookDeliveryView>> ListAsync(Guid? endpointId, WebhookDeliveryStatus? status, PageRequest page, CancellationToken ct)
    {
        IQueryable<WebhookDelivery> source = page.AfterId() is { } after
            ? db.WebhookDeliveries.FromSql($"SELECT * FROM webhook_deliveries WHERE id > {after}")
            : db.WebhookDeliveries;
        if (endpointId is { } endpoint)
        {
            source = source.Where(d => d.EndpointId == endpoint);
        }

        if (status is { } wanted)
        {
            source = source.Where(d => d.Status == wanted);
        }

        var rows = await (
                from delivery in source.AsNoTracking()
                join webhookEvent in db.WebhookEvents.AsNoTracking() on delivery.EventId equals webhookEvent.Id
                orderby delivery.Id
                select new WebhookDeliveryView(
                    delivery.Id,
                    delivery.EventId,
                    webhookEvent.Type,
                    delivery.EndpointId,
                    delivery.ObjectId,
                    delivery.Sequence,
                    delivery.Status,
                    delivery.Attempts,
                    delivery.NextAttemptAt,
                    delivery.LastStatusCode,
                    delivery.LastError,
                    delivery.DeliveredAt,
                    delivery.CreatedAt))
            .Take(page.Limit + 1)
            .ToListAsync(ct);
        return Paging.Build(rows, page.Limit, d => d.Id.ToString(), d => d);
    }

    /// <summary>Puts a failed delivery back to pending with its attempts reset, due now.</summary>
    public async Task<WebhookDeliveryView> RetryAsync(Guid id, CancellationToken ct)
    {
        var delivery = await db.WebhookDeliveries.SingleOrDefaultAsync(d => d.Id == id, ct) ?? throw DomainException.NotFound("Webhook delivery");
        if (delivery.Status != WebhookDeliveryStatus.Failed)
        {
            throw DomainException.InvalidState("Only failed deliveries can be retried.");
        }

        delivery.Status = WebhookDeliveryStatus.Pending;
        delivery.Attempts = 0;
        delivery.NextAttemptAt = clock.GetUtcNow();
        await db.SaveChangesAsync(ct);

        var type = await db.WebhookEvents.Where(e => e.Id == delivery.EventId).Select(e => e.Type).SingleAsync(ct);
        return new WebhookDeliveryView(
            delivery.Id,
            delivery.EventId,
            type,
            delivery.EndpointId,
            delivery.ObjectId,
            delivery.Sequence,
            delivery.Status,
            delivery.Attempts,
            delivery.NextAttemptAt,
            delivery.LastStatusCode,
            delivery.LastError,
            delivery.DeliveredAt,
            delivery.CreatedAt);
    }
}

/// <summary>Deletes idempotency records and delivered webhooks past their retention.</summary>
public sealed class PurgeRun(BillingDbContext db, ILogger<PurgeRun> logger) : ILoopRunner
{
    public static readonly TimeSpan IdempotencyRetention = TimeSpan.FromDays(7);
    public static readonly TimeSpan DeliveryRetention = TimeSpan.FromDays(30);

    public async Task RunOnceAsync(DateTimeOffset now, CancellationToken ct)
    {
        var idempotencyCutoff = now - IdempotencyRetention;
        var deliveryCutoff = now - DeliveryRetention;
        var records = await db.IdempotencyRecords.Where(r => r.CreatedAt < idempotencyCutoff).ExecuteDeleteAsync(ct);
        var deliveries = await db.WebhookDeliveries
            .Where(d => d.Status == WebhookDeliveryStatus.Succeeded && d.DeliveredAt < deliveryCutoff)
            .ExecuteDeleteAsync(ct);
        logger.LogInformation(
            "Purged {Records} idempotency records and {Deliveries} delivered webhooks",
            records,
            deliveries);
    }
}
