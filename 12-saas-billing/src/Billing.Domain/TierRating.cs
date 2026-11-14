namespace Billing.Domain;

/// <summary>One price tier; <see cref="UpTo"/> is the inclusive upper bound and null only on the last tier.</summary>
public sealed record PriceTierSpec(long? UpTo, long UnitAmountMinor, long FlatAmountMinor);

/// <summary>Prices a usage total against a tier table.</summary>
public static class TierRating
{
    /// <summary>Returns the amount for <paramref name="units"/> under the tier table and mode; zero units cost nothing.</summary>
    public static long Rate(long units, TierMode mode, IReadOnlyList<PriceTierSpec> tiers)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(units);
        if (tiers.Count == 0)
        {
            throw new ArgumentException("At least one tier is required.", nameof(tiers));
        }

        if (units == 0)
        {
            return 0;
        }

        return mode switch
        {
            TierMode.Graduated => Graduated(units, tiers),
            TierMode.Volume => Volume(units, tiers),
            _ => throw new ArgumentOutOfRangeException(nameof(mode)),
        };
    }

    /// <summary>Returns a description of the first problem with the tier table, or null when it is valid.</summary>
    public static string? Validate(IReadOnlyList<PriceTierSpec> tiers)
    {
        if (tiers.Count == 0)
        {
            return "At least one tier is required.";
        }

        long previous = 0;
        for (var i = 0; i < tiers.Count; i++)
        {
            var tier = tiers[i];
            var isLast = i == tiers.Count - 1;
            if (tier.UnitAmountMinor < 0 || tier.FlatAmountMinor < 0)
            {
                return "Tier amounts must not be negative.";
            }

            if (isLast)
            {
                if (tier.UpTo is not null)
                {
                    return "The last tier must not have an upper bound.";
                }

                continue;
            }

            if (tier.UpTo is null)
            {
                return "Only the last tier may omit its upper bound.";
            }

            if (tier.UpTo <= previous)
            {
                return "Tier upper bounds must be positive and strictly increasing.";
            }

            previous = tier.UpTo.Value;
        }

        return null;
    }

    private static long Graduated(long units, IReadOnlyList<PriceTierSpec> tiers)
    {
        long amount = 0;
        long lowerBound = 0;
        foreach (var tier in tiers)
        {
            if (units <= lowerBound)
            {
                break;
            }

            var upperBound = tier.UpTo ?? long.MaxValue;
            var unitsInTier = Math.Min(units, upperBound) - lowerBound;
            amount += (unitsInTier * tier.UnitAmountMinor) + tier.FlatAmountMinor;
            lowerBound = upperBound;
        }

        return amount;
    }

    private static long Volume(long units, IReadOnlyList<PriceTierSpec> tiers)
    {
        var tier = tiers.FirstOrDefault(t => t.UpTo is null || units <= t.UpTo) ?? tiers[^1];
        return (units * tier.UnitAmountMinor) + tier.FlatAmountMinor;
    }
}

/// <summary>Combines the quantities reported for one meter.</summary>
public static class UsageAggregation
{
    /// <summary>Returns the sum or the largest single quantity; zero when there are none.</summary>
    public static long Aggregate(MeterAggregation aggregation, IEnumerable<long> quantities) => aggregation switch
    {
        MeterAggregation.Sum => quantities.Sum(),
        MeterAggregation.Max => quantities.DefaultIfEmpty(0).Max(),
        _ => throw new ArgumentOutOfRangeException(nameof(aggregation)),
    };
}
