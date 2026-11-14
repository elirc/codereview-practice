using Billing.Core.Data;
using Billing.Core.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Webhooks;

/// <summary>Creates deliveries for recorded webhook events, in sequence order.</summary>
public sealed class WebhookFanOut(IServiceScopeFactory scopes, RequestContext request, ILogger<WebhookFanOut> logger) : ILoopRunner
{
    public const int BatchSize = 100;

    public async Task RunOnceAsync(DateTimeOffset now, CancellationToken ct)
    {
        for (var i = 0; i < BatchSize; i++)
        {
            await using var scope = scopes.CreateRunScope(request);
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            if (!await FanOutNextAsync(db, now, ct))
            {
                return;
            }
        }
    }

    /// <summary>Fans out the earliest event not yet fanned out; returns false when there is none.</summary>
    private async Task<bool> FanOutNextAsync(BillingDbContext db, DateTimeOffset now, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var webhookEvent = (await db.WebhookEvents
                .FromSql($"SELECT * FROM webhook_events WHERE fanned_out_at IS NULL ORDER BY sequence LIMIT 1 FOR UPDATE")
                .ToListAsync(ct))
            .SingleOrDefault();
        if (webhookEvent is null)
        {
            return false;
        }

        var type = webhookEvent.Type;
        var createdAt = webhookEvent.CreatedAt;
        var endpoints = await db.WebhookEndpoints.AsNoTracking()
            .Where(e => e.Status == WebhookEndpointStatus.Enabled
                && e.CreatedAt <= createdAt
                && (e.EventTypes.Contains(type) || e.EventTypes.Contains(WebhookEndpointService.AllEvents)))
            .Select(e => e.Id)
            .ToListAsync(ct);

        foreach (var endpointId in endpoints)
        {
            db.WebhookDeliveries.Add(new WebhookDelivery
            {
                Id = Guid.CreateVersion7(now),
                EventId = webhookEvent.Id,
                EndpointId = endpointId,
                ObjectId = webhookEvent.ObjectId,
                Sequence = webhookEvent.Sequence,
                Status = WebhookDeliveryStatus.Pending,
                Attempts = 0,
                NextAttemptAt = now,
                CreatedAt = now,
            });
        }

        webhookEvent.FannedOutAt = now;
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        logger.LogInformation(
            "Event {EventId} ({Type}, sequence {Sequence}) fanned out to {Count} endpoints",
            webhookEvent.Id,
            type,
            webhookEvent.Sequence,
            endpoints.Count);
        return true;
    }
}
