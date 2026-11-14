using Billing.Domain;

namespace Billing.Core.Data;

public sealed class Product
{
    public Guid Id { get; set; }

    public string Name { get; set; } = string.Empty;

    public bool Active { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class Plan
{
    public Guid Id { get; set; }

    public Guid ProductId { get; set; }

    public string Code { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public BillingInterval Interval { get; set; }

    public string Currency { get; set; } = string.Empty;

    public int TrialDays { get; set; }

    public bool Active { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public List<PlanItem> Items { get; set; } = [];
}

public sealed class PlanItem
{
    public Guid Id { get; set; }

    public Guid PlanId { get; set; }

    public int Position { get; set; }

    public PlanItemKind Kind { get; set; }

    public string Name { get; set; } = string.Empty;

    public long? UnitAmountMinor { get; set; }

    public string? MeterCode { get; set; }

    public TierMode? TierMode { get; set; }

    public List<PriceTier> Tiers { get; set; } = [];
}

public sealed class PriceTier
{
    public Guid PlanItemId { get; set; }

    public int Position { get; set; }

    public long? UpTo { get; set; }

    public long UnitAmountMinor { get; set; }

    public long FlatAmountMinor { get; set; }
}

public sealed class Meter
{
    public string Code { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public MeterAggregation Aggregation { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class TaxRate
{
    public Guid Id { get; set; }

    public string Country { get; set; } = string.Empty;

    public string? Region { get; set; }

    public int RateBps { get; set; }

    public DateOnly ValidFrom { get; set; }

    public DateOnly? ValidTo { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}
