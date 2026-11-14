namespace Billing.Domain;

/// <summary>Length of one billing period.</summary>
public enum BillingInterval
{
    Month,
    Year,
}

/// <summary>Kind of price a plan item charges.</summary>
public enum PlanItemKind
{
    Flat,
    PerSeat,
    Usage,
}

/// <summary>How tiered usage prices are applied.</summary>
public enum TierMode
{
    Graduated,
    Volume,
}

/// <summary>How a meter combines the quantities of one period.</summary>
public enum MeterAggregation
{
    Sum,
    Max,
}
