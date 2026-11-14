namespace Billing.Domain;

/// <summary>A stored tax rate, valid on <c>[ValidFrom, ValidTo)</c>.</summary>
public sealed record TaxRateCandidate(string Country, string? Region, int RateBps, DateOnly ValidFrom, DateOnly? ValidTo)
{
    public bool AppliesOn(DateOnly date) => ValidFrom <= date && (ValidTo is null || date < ValidTo.Value);
}

/// <summary>Tax arithmetic on invoice lines.</summary>
public static class TaxMath
{
    public const int MaxRateBps = 5000;

    /// <summary>Returns the tax on one line: <c>amount × rateBps / 10000</c> rounded half away from zero.</summary>
    public static long LineTax(long amountMinor, int rateBps)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(rateBps);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(rateBps, MaxRateBps);
        return IntegerMath.DivideRoundHalfAwayFromZero(amountMinor * rateBps, 10_000);
    }

    /// <summary>
    /// Returns the rate for an invoice issued on <paramref name="issueDate"/>: the regional rate when one applies,
    /// otherwise the national rate, otherwise zero; tax-exempt customers always get zero.
    /// </summary>
    public static int SelectRate(
        IEnumerable<TaxRateCandidate> rates,
        string country,
        string? region,
        DateOnly issueDate,
        bool taxExempt)
    {
        if (taxExempt)
        {
            return 0;
        }

        var applicable = rates
            .Where(r => string.Equals(r.Country, country, StringComparison.Ordinal) && r.AppliesOn(issueDate))
            .ToList();

        if (region is not null)
        {
            var regional = applicable.FirstOrDefault(r => string.Equals(r.Region, region, StringComparison.Ordinal));
            if (regional is not null)
            {
                return regional.RateBps;
            }
        }

        return applicable.FirstOrDefault(r => r.Region is null)?.RateBps ?? 0;
    }
}

/// <summary>Tax split for credit notes against invoice lines.</summary>
public static class CreditNoteMath
{
    /// <summary>
    /// Returns the tax credited with <paramref name="creditMinor"/> of a line: the whole remaining line tax when the
    /// credit takes the whole remaining amount, otherwise the rounded rate share, never more than the remaining tax.
    /// </summary>
    public static long LineTax(long creditMinor, long lineAmountMinor, long lineCreditedMinor, long lineTaxMinor, long lineCreditedTaxMinor, int rateBps)
    {
        var remainingAmount = lineAmountMinor - lineCreditedMinor;
        var remainingTax = lineTaxMinor - lineCreditedTaxMinor;
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(creditMinor);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(creditMinor, remainingAmount);

        if (creditMinor == remainingAmount)
        {
            return remainingTax;
        }

        return Math.Min(TaxMath.LineTax(creditMinor, rateBps), remainingTax);
    }
}
