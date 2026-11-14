using Billing.Core.Data;

namespace Billing.Core.Views;

public sealed record SubscriptionView(
    Guid Id,
    Guid CustomerId,
    Guid ProductId,
    Guid PlanId,
    string PlanCode,
    SubscriptionStatus Status,
    int Quantity,
    DateOnly AnchorDate,
    int PeriodIndex,
    DateOnly? CurrentPeriodStart,
    DateOnly? CurrentPeriodEnd,
    DateOnly? TrialEndsOn,
    DateTimeOffset? NextBillingAt,
    Guid? PendingPlanId,
    string? PendingPlanCode,
    int? PendingQuantity,
    bool CancelAtPeriodEnd,
    DateTimeOffset? CanceledAt,
    CancelReason? CancelReason,
    DateOnly? EndedOn,
    DateTimeOffset CreatedAt)
{
    public static SubscriptionView From(Subscription s, IReadOnlyDictionary<Guid, string> planCodes) => new(
        s.Id,
        s.CustomerId,
        s.ProductId,
        s.PlanId,
        planCodes[s.PlanId],
        s.Status,
        s.Quantity,
        s.AnchorDate,
        s.PeriodIndex,
        s.CurrentPeriodStart,
        s.CurrentPeriodEnd,
        s.TrialEndsOn,
        s.NextBillingAt,
        s.PendingPlanId,
        s.PendingPlanId is { } pending ? planCodes[pending] : null,
        s.PendingQuantity,
        s.CancelAtPeriodEnd,
        s.CanceledAt,
        s.CancelReason,
        s.EndedOn,
        s.CreatedAt);
}

/// <summary>The plan, quantity and status of a subscription before a change.</summary>
public sealed record SubscriptionSnapshot(string PlanCode, int Quantity, SubscriptionStatus Status);
