using Billing.Domain;
using Xunit;

namespace Billing.Domain.Tests;

public class IntegerMathTests
{
    [Theory]
    [InlineData(25, 10, 3)]
    [InlineData(-25, 10, -3)]
    [InlineData(24, 10, 2)]
    [InlineData(-24, 10, -2)]
    [InlineData(0, 10, 0)]
    public void HalfAwayFromZeroRoundsHalvesOutwards(long numerator, long denominator, long expected)
    {
        Assert.Equal(expected, IntegerMath.DivideRoundHalfAwayFromZero(numerator, denominator));
    }

    [Theory]
    [InlineData(25, 10, 3)]
    [InlineData(-25, 10, -2)]
    [InlineData(-26, 10, -3)]
    [InlineData(14, 10, 1)]
    public void HalfUpRoundsHalvesTowardsPositiveInfinity(long numerator, long denominator, long expected)
    {
        Assert.Equal(expected, IntegerMath.DivideRoundHalfUp(numerator, denominator));
    }

    [Theory]
    [InlineData(7, 2, 3)]
    [InlineData(-7, 2, -4)]
    [InlineData(-6, 2, -3)]
    public void FloorDivideRoundsDown(long numerator, long denominator, long expected)
    {
        Assert.Equal(expected, IntegerMath.FloorDivide(numerator, denominator));
    }
}
