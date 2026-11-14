using System.Globalization;
using System.Text;
using Billing.Core.Data;
using Billing.Core.Services;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Webhooks;

/// <summary>Sends due webhook deliveries and stores their outcomes.</summary>
public sealed class WebhookDispatcher(
    BillingDbContext db,
    IServiceScopeFactory scopes,
    RequestContext request,
    TimeProvider clock,
    WebhookSender sender,
    ILogger<WebhookDispatcher> logger) : ILoopRunner
{
    public const int BatchSize = 50;
    public static readonly TimeSpan ClaimDuration = TimeSpan.FromMinutes(5);

    public async Task RunOnceAsync(DateTimeOffset now, CancellationToken ct)
    {
        foreach (var deliveryId in await ClaimDueAsync(now, ct))
        {
            try
            {
                var outcome = await SendAsync(deliveryId, ct);
                if (outcome is not null)
                {
                    await CompleteAsync(deliveryId, outcome, now, ct);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Webhook delivery {DeliveryId} failed unexpectedly", deliveryId);
            }
        }
    }

    /// <summary>
    /// Claims up to <see cref="BatchSize"/> due pending deliveries and returns their ids.
    /// </summary>
    public async Task<IReadOnlyList<Guid>> ClaimDueAsync(DateTimeOffset now, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var claimed = await db.WebhookDeliveries
            .FromSql(
                $"""
                SELECT d.* FROM webhook_deliveries d
                WHERE d.status = 'pending' AND d.next_attempt_at <= {now}
                  AND NOT EXISTS (
                      SELECT 1 FROM webhook_deliveries p
                      WHERE p.endpoint_id = d.endpoint_id
                        AND p.object_id = d.object_id
                        AND p.status = 'pending'
                        AND p.sequence < d.sequence)
                ORDER BY d.sequence
                LIMIT {BatchSize}
                FOR UPDATE OF d SKIP LOCKED
                """)
            .ToListAsync(ct);

        foreach (var delivery in claimed)
        {
            delivery.NextAttemptAt = now + ClaimDuration;
        }

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        db.ChangeTracker.Clear();
        return claimed.Select(d => d.Id).ToList();
    }

    /// <summary>
    /// Sends the stored event body of a claimed delivery, signed with the endpoint's current secrets; returns null
    /// without sending when the delivery is no longer pending or its endpoint is disabled.
    /// </summary>
    public async Task<DeliveryOutcome?> SendAsync(Guid deliveryId, CancellationToken ct)
    {
        await using var scope = scopes.CreateRunScope(request);
        var readDb = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var target = await (
                from delivery in readDb.WebhookDeliveries.AsNoTracking()
                join webhookEvent in readDb.WebhookEvents.AsNoTracking() on delivery.EventId equals webhookEvent.Id
                join endpoint in readDb.WebhookEndpoints.AsNoTracking() on delivery.EndpointId equals endpoint.Id
                where delivery.Id == deliveryId
                select new
                {
                    delivery.Attempts,
                    DeliveryStatus = delivery.Status,
                    EndpointStatus = endpoint.Status,
                    webhookEvent.Id,
                    webhookEvent.Type,
                    webhookEvent.Body,
                    endpoint.Url,
                    endpoint.Secret,
                    endpoint.PreviousSecret,
                    endpoint.PreviousSecretExpiresAt,
                })
            .SingleAsync(ct);
        if (target.DeliveryStatus != WebhookDeliveryStatus.Pending || target.EndpointStatus != WebhookEndpointStatus.Enabled)
        {
            return null;
        }

        var now = clock.GetUtcNow();
        var body = Encoding.UTF8.GetBytes(target.Body);
        var previousSecret = target.PreviousSecretExpiresAt > now ? target.PreviousSecret : null;
        var attempt = target.Attempts + 1;
        var headers = new Dictionary<string, string>
        {
            ["Billing-Event-Id"] = target.Id.ToString(),
            ["Billing-Event-Type"] = target.Type,
            ["Billing-Delivery-Attempt"] = attempt.ToString(CultureInfo.InvariantCulture),
            ["Billing-Signature"] = WebhookSignature.Header(now.ToUnixTimeSeconds(), body, target.Secret, previousSecret),
        };

        logger.LogInformation("Webhook delivery {DeliveryId} attempt {Attempt} of event {EventId} started", deliveryId, attempt, target.Id);
        return await sender.SendAsync(target.Url, body, headers, ct);
    }

    /// <summary>Stores the outcome of a delivery attempt and schedules the next one when it failed.</summary>
    public async Task CompleteAsync(Guid deliveryId, DeliveryOutcome outcome, DateTimeOffset now, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var delivery = (await db.WebhookDeliveries
                .FromSql($"SELECT * FROM webhook_deliveries WHERE id = {deliveryId} FOR UPDATE")
                .ToListAsync(ct))
            .Single();
        if (delivery.Status != WebhookDeliveryStatus.Pending)
        {
            return;
        }

        delivery.LastStatusCode = outcome.StatusCode;
        delivery.LastError = outcome.Error;
        if (outcome.Succeeded)
        {
            delivery.Status = WebhookDeliveryStatus.Succeeded;
            delivery.DeliveredAt = now;
            delivery.Attempts++;
            logger.LogInformation("Webhook delivery {DeliveryId} succeeded with {StatusCode}", deliveryId, outcome.StatusCode);
        }
        else if (outcome.StatusCode == 410)
        {
            delivery.Status = WebhookDeliveryStatus.Failed;
            delivery.Attempts++;
            await db.WebhookEndpoints
                .Where(e => e.Id == delivery.EndpointId)
                .ExecuteUpdateAsync(s => s.SetProperty(e => e.Status, WebhookEndpointStatus.Disabled), ct);
            await db.WebhookDeliveries
                .Where(d => d.EndpointId == delivery.EndpointId && d.Status == WebhookDeliveryStatus.Pending && d.Id != deliveryId)
                .ExecuteUpdateAsync(s => s.SetProperty(d => d.Status, WebhookDeliveryStatus.Failed).SetProperty(d => d.LastError, "endpoint_gone"), ct);
            logger.LogWarning("Webhook endpoint {EndpointId} answered 410 and was disabled", delivery.EndpointId);
        }
        else
        {
            delivery.Attempts++;
            var retryDelay = WebhookRetrySchedule.RetryDelay(delivery.Attempts);
            if (retryDelay is { } delay)
            {
                delivery.NextAttemptAt = now + delay;
            }
            else
            {
                delivery.Status = WebhookDeliveryStatus.Failed;
            }

            logger.LogInformation(
                "Webhook delivery {DeliveryId} attempt {Attempt} failed ({StatusCode} {Error}); status {Status}",
                deliveryId,
                delivery.Attempts,
                outcome.StatusCode,
                outcome.Error,
                delivery.Status);
        }

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
    }
}
