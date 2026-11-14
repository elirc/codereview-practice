using Billing.Api.Validation;
using Billing.Domain;

namespace Billing.Api.Requests;

public sealed record CreateProductRequest(string? Name);

public sealed record CreateMeterRequest(string? Code, string? Name, MeterAggregation? Aggregation);

public sealed record PriceTierRequest(long? UpTo, long? UnitAmountMinor, long? FlatAmountMinor);

public sealed record PlanItemRequest(
    PlanItemKind? Kind,
    string? Name,
    long? UnitAmountMinor,
    string? MeterCode,
    TierMode? TierMode,
    IReadOnlyList<PriceTierRequest>? Tiers);

public sealed record CreatePlanRequest(
    Guid? ProductId,
    string? Code,
    string? Name,
    BillingInterval? Interval,
    string? Currency,
    int? TrialDays,
    IReadOnlyList<PlanItemRequest>? Items);

public sealed record CreateTaxRateRequest(string? Country, string? Region, int? RateBps, DateOnly? ValidFrom, DateOnly? ValidTo);

internal sealed class CreateProductValidator : IValidator<CreateProductRequest>
{
    public void Validate(CreateProductRequest value, ValidationErrors errors) => errors.Text(value.Name, "name", 1, 200);
}

internal sealed class CreateMeterValidator : IValidator<CreateMeterRequest>
{
    public void Validate(CreateMeterRequest value, ValidationErrors errors)
    {
        errors.Matches(value.Code, "code", Patterns.Code(), "Must be 1-64 lower-case letters, digits, '-' or '_'.");
        errors.Text(value.Name, "name", 1, 200);
        errors.Required(value.Aggregation, "aggregation");
    }
}

internal sealed class CreatePlanValidator : IValidator<CreatePlanRequest>
{
    public const long MaxAmountMinor = 100_000_000_00;

    public void Validate(CreatePlanRequest value, ValidationErrors errors)
    {
        errors.Required(value.ProductId, "productId");
        errors.Matches(value.Code, "code", Patterns.Code(), "Must be 1-64 lower-case letters, digits, '-' or '_'.");
        errors.Text(value.Name, "name", 1, 200);
        errors.Required(value.Interval, "interval");
        if (errors.Required(value.Currency, "currency") && !Currencies.IsSupported(value.Currency))
        {
            errors.Add("currency", "Must be one of USD, EUR or GBP.");
        }

        errors.Range(value.TrialDays, "trialDays", 0, 90, required: false);

        if (value.Items is null || value.Items.Count == 0)
        {
            errors.Add("items", "At least one item is required.");
            return;
        }

        if (value.Items.Count > 20)
        {
            errors.Add("items", "At most 20 items are allowed.");
        }

        var seatItems = 0;
        var meters = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < value.Items.Count; i++)
        {
            var item = value.Items[i];
            var path = $"items[{i}]";
            errors.Text(item.Name, $"{path}.name", 1, 200);
            if (!errors.Required(item.Kind, $"{path}.kind"))
            {
                continue;
            }

            switch (item.Kind)
            {
                case PlanItemKind.Flat or PlanItemKind.PerSeat:
                    errors.Range(item.UnitAmountMinor, $"{path}.unitAmountMinor", 0, MaxAmountMinor);
                    if (item.MeterCode is not null || item.TierMode is not null || item.Tiers is not null)
                    {
                        errors.Add(path, "Flat and per-seat items take only unitAmountMinor.");
                    }

                    if (item.Kind == PlanItemKind.PerSeat && ++seatItems > 1)
                    {
                        errors.Add(path, "A plan has at most one per-seat item.");
                    }

                    break;

                case PlanItemKind.Usage:
                    ValidateUsageItem(item, path, meters, errors);
                    break;
            }
        }
    }

    private static void ValidateUsageItem(PlanItemRequest item, string path, HashSet<string> meters, ValidationErrors errors)
    {
        if (item.UnitAmountMinor is not null)
        {
            errors.Add($"{path}.unitAmountMinor", "Usage items are priced by their tiers.");
        }

        if (errors.Matches(item.MeterCode, $"{path}.meterCode", Patterns.Code(), "Must be a meter code.")
            && !meters.Add(item.MeterCode!))
        {
            errors.Add($"{path}.meterCode", "A plan has at most one usage item per meter.");
        }

        errors.Required(item.TierMode, $"{path}.tierMode");
        if (item.Tiers is null || item.Tiers.Count is 0 or > 20)
        {
            errors.Add($"{path}.tiers", "Between 1 and 20 tiers are required.");
            return;
        }

        for (var t = 0; t < item.Tiers.Count; t++)
        {
            var tier = item.Tiers[t];
            errors.Range(tier.UnitAmountMinor, $"{path}.tiers[{t}].unitAmountMinor", 0, MaxAmountMinor);
            errors.Range(tier.FlatAmountMinor, $"{path}.tiers[{t}].flatAmountMinor", 0, MaxAmountMinor);
            errors.Range(tier.UpTo, $"{path}.tiers[{t}].upTo", 1, long.MaxValue / 1_000_000, required: false);
        }

        var specs = item.Tiers.Select(t => new PriceTierSpec(t.UpTo, t.UnitAmountMinor ?? 0, t.FlatAmountMinor ?? 0)).ToList();
        if (TierRating.Validate(specs) is { } problem)
        {
            errors.Add($"{path}.tiers", problem);
        }
    }
}

internal sealed class CreateTaxRateValidator : IValidator<CreateTaxRateRequest>
{
    public void Validate(CreateTaxRateRequest value, ValidationErrors errors)
    {
        errors.Matches(value.Country, "country", Patterns.Country(), "Must be an ISO 3166-1 alpha-2 code in upper case.");
        errors.Text(value.Region, "region", 1, 50, required: false);
        errors.Range(value.RateBps, "rateBps", 0, TaxMath.MaxRateBps);
        if (errors.Required(value.ValidFrom, "validFrom") && value.ValidTo is { } validTo && validTo <= value.ValidFrom)
        {
            errors.Add("validTo", "Must be after validFrom.");
        }
    }
}
