using Billing.Domain;
using Xunit;

namespace Billing.Domain.Tests;

public class TierRatingTests
{
    private static readonly PriceTierSpec[] Tiers =
    [
        new(1_000, 0, 0),
        new(10_000, 2, 0),
        new(null, 1, 0),
    ];

    [Theory]
    [InlineData(12_500, 20_500)]
    [InlineData(1_000, 0)]
    [InlineData(1_001, 2)]
    [InlineData(10_000, 18_000)]
    [InlineData(10_001, 18_001)]
    [InlineData(0, 0)]
    public void GraduatedSpreadsUnitsOverTheTiers(long units, long expected)
    {
        Assert.Equal(expected, TierRating.Rate(units, TierMode.Graduated, Tiers));
    }

    [Theory]
    [InlineData(12_500, 12_500)]
    [InlineData(1_000, 0)]
    [InlineData(1_001, 2_002)]
    [InlineData(10_000, 20_000)]
    [InlineData(10_001, 10_001)]
    public void VolumePricesAllUnitsAtTheTierContainingTheTotal(long units, long expected)
    {
        Assert.Equal(expected, TierRating.Rate(units, TierMode.Volume, Tiers));
    }

    [Fact]
    public void FlatTierAmountsAreAddedForEveryTierReached()
    {
        PriceTierSpec[] tiers = [new(10, 0, 500), new(null, 100, 50)];

        Assert.Equal(500, TierRating.Rate(10, TierMode.Graduated, tiers));
        Assert.Equal(500 + 100 + 50, TierRating.Rate(11, TierMode.Graduated, tiers));
        Assert.Equal((11 * 100) + 50, TierRating.Rate(11, TierMode.Volume, tiers));
    }

    [Fact]
    public void ValidateAcceptsAWellFormedTable()
    {
        Assert.Null(TierRating.Validate(Tiers));
    }

    [Fact]
    public void ValidateRejectsMalformedTables()
    {
        var tables = new[]
        {
            Array.Empty<PriceTierSpec>(),
            new PriceTierSpec[] { new(100, 1, 0) },
            new PriceTierSpec[] { new(null, 1, 0), new(null, 1, 0) },
            new PriceTierSpec[] { new(100, 1, 0), new(100, 1, 0), new(null, 1, 0) },
            new PriceTierSpec[] { new(0, 1, 0), new(null, 1, 0) },
            new PriceTierSpec[] { new(null, -1, 0) },
        };

        Assert.All(tables, table => Assert.NotNull(TierRating.Validate(table)));
    }

    [Fact]
    public void SumAggregationAddsQuantities()
    {
        Assert.Equal(24, UsageAggregation.Aggregate(MeterAggregation.Sum, [5, 12, 7]));
    }

    [Fact]
    public void MaxAggregationTakesTheLargestQuantity()
    {
        Assert.Equal(12, UsageAggregation.Aggregate(MeterAggregation.Max, [5, 12, 7]));
    }

    [Fact]
    public void AggregationOfNoQuantitiesIsZero()
    {
        Assert.Equal(0, UsageAggregation.Aggregate(MeterAggregation.Max, []));
        Assert.Equal(0, UsageAggregation.Aggregate(MeterAggregation.Sum, []));
    }
}
