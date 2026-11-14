using Billing.Core.Data;
using Billing.Domain;

namespace Billing.Core.Views;

public sealed record ProductView(Guid Id, string Name, bool Active, DateTimeOffset CreatedAt)
{
    public static ProductView From(Product p) => new(p.Id, p.Name, p.Active, p.CreatedAt);
}

public sealed record PriceTierView(long? UpTo, long UnitAmountMinor, long FlatAmountMinor);

public sealed record PlanItemView(
    Guid Id,
    PlanItemKind Kind,
    string Name,
    long? UnitAmountMinor,
    string? MeterCode,
    TierMode? TierMode,
    IReadOnlyList<PriceTierView> Tiers);

public sealed record PlanView(
    Guid Id,
    Guid ProductId,
    string Code,
    string Name,
    BillingInterval Interval,
    string Currency,
    int TrialDays,
    bool Active,
    IReadOnlyList<PlanItemView> Items)
{
    public static PlanView From(Plan p) => new(
        p.Id,
        p.ProductId,
        p.Code,
        p.Name,
        p.Interval,
        p.Currency,
        p.TrialDays,
        p.Active,
        p.Items
            .OrderBy(i => i.Position)
            .Select(i => new PlanItemView(
                i.Id,
                i.Kind,
                i.Name,
                i.UnitAmountMinor,
                i.MeterCode,
                i.TierMode,
                i.Tiers.OrderBy(t => t.Position).Select(t => new PriceTierView(t.UpTo, t.UnitAmountMinor, t.FlatAmountMinor)).ToList()))
            .ToList());
}

public sealed record MeterView(string Code, string Name, MeterAggregation Aggregation)
{
    public static MeterView From(Meter m) => new(m.Code, m.Name, m.Aggregation);
}

public sealed record TaxRateView(Guid Id, string Country, string? Region, int RateBps, DateOnly ValidFrom, DateOnly? ValidTo)
{
    public static TaxRateView From(TaxRate r) => new(r.Id, r.Country, r.Region, r.RateBps, r.ValidFrom, r.ValidTo);
}
