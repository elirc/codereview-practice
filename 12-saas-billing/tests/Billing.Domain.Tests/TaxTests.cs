using Billing.Domain;
using Xunit;

namespace Billing.Domain.Tests;

public class TaxTests
{
    private static readonly TaxRateCandidate[] Rates =
    [
        new("US", null, 500, new DateOnly(2020, 1, 1), null),
        new("US", "CA", 825, new DateOnly(2020, 1, 1), new DateOnly(2026, 7, 1)),
        new("US", "CA", 900, new DateOnly(2026, 7, 1), null),
        new("DE", null, 1900, new DateOnly(2020, 1, 1), null),
    ];

    [Theory]
    [InlineData(-968, 825, -80)]
    [InlineData(1613, 825, 133)]
    [InlineData(33, 1000, 3)]
    [InlineData(5, 1000, 1)]
    [InlineData(-5, 1000, -1)]
    [InlineData(4, 1000, 0)]
    [InlineData(1000, 0, 0)]
    public void LineTaxRoundsHalfAwayFromZero(long amount, int rate, long expected)
    {
        Assert.Equal(expected, TaxMath.LineTax(amount, rate));
    }

    [Fact]
    public void InvoiceTaxIsTheSumOfRoundedLineTaxes()
    {
        long[] lines = [33, 33, 33];

        var tax = lines.Sum(l => TaxMath.LineTax(l, 1000));

        Assert.Equal(9, tax);
        Assert.Equal(10, TaxMath.LineTax(lines.Sum(), 1000));
    }

    [Fact]
    public void UpgradeExampleTotalsSixNinetyEight()
    {
        long[] amounts = [-968, 1613];

        var total = amounts.Sum() + amounts.Sum(a => TaxMath.LineTax(a, 825));

        Assert.Equal(698, total);
    }

    [Fact]
    public void RegionalRateTakesPrecedenceOverTheCountryRate()
    {
        Assert.Equal(825, TaxMath.SelectRate(Rates, "US", "CA", new DateOnly(2026, 6, 30), false));
    }

    [Fact]
    public void RateEndingOnTheIssueDateDoesNotApplyThatDay()
    {
        Assert.Equal(900, TaxMath.SelectRate(Rates, "US", "CA", new DateOnly(2026, 7, 1), false));
    }

    [Fact]
    public void CountryRateAppliesWhenNoRegionalRateMatches()
    {
        Assert.Equal(500, TaxMath.SelectRate(Rates, "US", "NY", new DateOnly(2026, 6, 30), false));
        Assert.Equal(500, TaxMath.SelectRate(Rates, "US", null, new DateOnly(2026, 6, 30), false));
    }

    [Fact]
    public void UnknownCountryHasNoTax()
    {
        Assert.Equal(0, TaxMath.SelectRate(Rates, "FR", null, new DateOnly(2026, 6, 30), false));
    }

    [Fact]
    public void RateNotYetValidDoesNotApply()
    {
        Assert.Equal(0, TaxMath.SelectRate(Rates, "DE", null, new DateOnly(2019, 12, 31), false));
    }

    [Fact]
    public void TaxExemptCustomersPayNoTax()
    {
        Assert.Equal(0, TaxMath.SelectRate(Rates, "US", "CA", new DateOnly(2026, 6, 30), true));
    }
}
