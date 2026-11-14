using System.Text.Json;
using Billing.Core.Data;
using Billing.Core.Json;
using Billing.Core.Views;
using Microsoft.EntityFrameworkCore;

namespace Billing.Core.Services;

/// <summary>Webhook event types.</summary>
public static class EventTypes
{
    public const string SubscriptionCreated = "subscription.created";
    public const string SubscriptionTrialEnded = "subscription.trial_ended";
    public const string SubscriptionUpdated = "subscription.updated";
    public const string SubscriptionCanceled = "subscription.canceled";
    public const string InvoiceFinalized = "invoice.finalized";
    public const string InvoicePaid = "invoice.paid";
    public const string InvoiceVoided = "invoice.voided";
    public const string InvoiceMarkedUncollectible = "invoice.marked_uncollectible";
    public const string InvoicePaymentFailed = "invoice.payment_failed";
    public const string CreditNoteCreated = "credit_note.created";
    public const string CreditNoteRefundFailed = "credit_note.refund_failed";

    public static readonly IReadOnlyList<string> All =
    [
        SubscriptionCreated,
        SubscriptionTrialEnded,
        SubscriptionUpdated,
        SubscriptionCanceled,
        InvoiceFinalized,
        InvoicePaid,
        InvoiceVoided,
        InvoiceMarkedUncollectible,
        InvoicePaymentFailed,
        CreditNoteCreated,
        CreditNoteRefundFailed,
    ];
}

/// <summary>The serialised body of every webhook event.</summary>
public sealed record WebhookEnvelope(
    Guid Id,
    string Type,
    int SchemaVersion,
    DateTimeOffset OccurredAt,
    string AggregateType,
    Guid AggregateId,
    long Sequence,
    string RequestId,
    IReadOnlyDictionary<string, object?> Data);

/// <summary>Writes webhook events to <c>webhook_events</c> in the caller's transaction.</summary>
public sealed class EventRecorder(BillingDbContext db, TimeProvider clock, RequestContext request, ViewLoader views)
{
    public const int SchemaVersion = 1;

    /// <summary>Records an invoice event whose object is the invoice as currently stored.</summary>
    public async Task InvoiceAsync(string type, Guid invoiceId, IReadOnlyDictionary<string, object?>? extra, CancellationToken ct)
    {
        await db.SaveChangesAsync(ct);
        var view = await views.InvoiceAsync(invoiceId, ct)
            ?? throw new InvalidOperationException($"Invoice {invoiceId} does not exist.");
        await RecordAsync(type, "invoice", invoiceId, view, extra, ct);
    }

    /// <summary>Records a subscription event whose object is the subscription as given.</summary>
    public async Task SubscriptionAsync(string type, Subscription subscription, IReadOnlyDictionary<string, object?>? extra, CancellationToken ct)
    {
        await db.SaveChangesAsync(ct);
        var view = await views.SubscriptionAsync(subscription, ct);
        await RecordAsync(type, "subscription", subscription.Id, view, extra, ct);
    }

    /// <summary>Records a <c>subscription.updated</c> event carrying the state before the change.</summary>
    public Task SubscriptionUpdatedAsync(Subscription subscription, SubscriptionSnapshot previous, CancellationToken ct) =>
        SubscriptionAsync(
            EventTypes.SubscriptionUpdated,
            subscription,
            new Dictionary<string, object?> { ["previous"] = previous },
            ct);

    /// <summary>Records an event with the given object representation and extra data fields.</summary>
    public async Task RecordAsync(
        string type,
        string objectType,
        Guid objectId,
        object view,
        IReadOnlyDictionary<string, object?>? extra,
        CancellationToken ct)
    {
        var sequence = (await db.Database
            .SqlQuery<long>($"SELECT nextval(pg_get_serial_sequence('webhook_events', 'sequence')) AS \"Value\"")
            .ToListAsync(ct))
            .Single();

        var now = clock.GetUtcNow();
        var data = new Dictionary<string, object?> { ["object"] = view };
        foreach (var (key, value) in extra ?? new Dictionary<string, object?>())
        {
            data[key] = value;
        }

        var id = Ids.New(clock);
        var envelope = new WebhookEnvelope(id, type, SchemaVersion, now, objectType, objectId, sequence, request.RequestId, data);
        db.WebhookEvents.Add(new WebhookEvent
        {
            Id = id,
            Sequence = sequence,
            Type = type,
            ObjectType = objectType,
            ObjectId = objectId,
            Body = JsonSerializer.Serialize(envelope, BillingJson.Options),
            CreatedAt = now,
        });
        await db.SaveChangesAsync(ct);
    }
}
