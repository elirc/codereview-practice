namespace Billing.Core.Data;

public sealed class Subscription
{
    public Guid Id { get; set; }

    public Guid CustomerId { get; set; }

    public Guid ProductId { get; set; }

    public Guid PlanId { get; set; }

    public SubscriptionStatus Status { get; set; }

    public int Quantity { get; set; }

    public DateOnly AnchorDate { get; set; }

    public int PeriodIndex { get; set; }

    public DateOnly? CurrentPeriodStart { get; set; }

    public DateOnly? CurrentPeriodEnd { get; set; }

    public DateOnly? TrialEndsOn { get; set; }

    public DateTimeOffset? NextBillingAt { get; set; }

    public Guid? PendingPlanId { get; set; }

    public int? PendingQuantity { get; set; }

    public bool CancelAtPeriodEnd { get; set; }

    public DateTimeOffset? CanceledAt { get; set; }

    public CancelReason? CancelReason { get; set; }

    public DateOnly? EndedOn { get; set; }

    public DateTimeOffset? FinalSealedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class SubscriptionPeriod
{
    public Guid Id { get; set; }

    public Guid SubscriptionId { get; set; }

    public int Index { get; set; }

    public DateOnly PeriodStart { get; set; }

    public DateOnly PeriodEnd { get; set; }

    public Guid PlanId { get; set; }

    public DateTimeOffset? UsageSealedAt { get; set; }
}

public sealed class UsageEvent
{
    public Guid Id { get; set; }

    public Guid SubscriptionId { get; set; }

    public string MeterCode { get; set; } = string.Empty;

    public string EventKey { get; set; } = string.Empty;

    public long Quantity { get; set; }

    public DateTimeOffset OccurredAt { get; set; }

    public DateTimeOffset ReceivedAt { get; set; }

    public Guid? BilledPeriodId { get; set; }

    public bool Late { get; set; }
}
