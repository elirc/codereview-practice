namespace Billing.Domain;

/// <summary>Integer division with explicit rounding, used for every money calculation.</summary>
public static class IntegerMath
{
    /// <summary>Returns <paramref name="numerator"/> / <paramref name="denominator"/> rounded to the nearest integer, halves away from zero.</summary>
    public static long DivideRoundHalfAwayFromZero(long numerator, long denominator)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(denominator);

        var quotient = numerator / denominator;
        var remainder = numerator % denominator;
        if (Math.Abs(remainder) * 2 >= denominator)
        {
            quotient += Math.Sign(numerator);
        }

        return quotient;
    }

    /// <summary>Returns <paramref name="numerator"/> / <paramref name="denominator"/> rounded to the nearest integer, halves towards positive infinity.</summary>
    public static long DivideRoundHalfUp(long numerator, long denominator)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(denominator);
        return FloorDivide((2 * numerator) + denominator, 2 * denominator);
    }

    /// <summary>Returns the largest integer less than or equal to <paramref name="numerator"/> / <paramref name="denominator"/>.</summary>
    public static long FloorDivide(long numerator, long denominator)
    {
        ArgumentOutOfRangeException.ThrowIfZero(denominator);

        var quotient = numerator / denominator;
        if (numerator % denominator != 0 && (numerator < 0) != (denominator < 0))
        {
            quotient--;
        }

        return quotient;
    }
}
