namespace Billing.Domain;

/// <summary>A recurring charge billed in advance for a period: a flat item or a per-seat item with its quantity.</summary>
public sealed record AdvanceCharge(Guid PlanItemId, PlanItemKind Kind, string Name, long UnitAmountMinor, int Quantity)
{
    public long AmountMinor => Kind == PlanItemKind.PerSeat ? UnitAmountMinor * Quantity : UnitAmountMinor;

    public long BilledQuantity => Kind == PlanItemKind.PerSeat ? Quantity : 1;
}

/// <summary>One line of a proration invoice; credits carry a negative amount.</summary>
public sealed record ProrationLine(Guid PlanItemId, bool IsCredit, string Name, long Quantity, long AmountMinor)
{
    public string Description => IsCredit ? $"Unused time on {Name}" : $"Remaining time on {Name}";
}

/// <summary>Mid-period plan and quantity change arithmetic.</summary>
public static class Proration
{
    /// <summary>Returns the recurring amount of one period for the given advance charges.</summary>
    public static long Recurring(IEnumerable<AdvanceCharge> charges) => charges.Sum(c => c.AmountMinor);

    /// <summary>Returns <c>amount × remainingDays / periodDays</c> rounded half up.</summary>
    public static long Prorate(long amountMinor, int remainingDays, int periodDays)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(periodDays);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(remainingDays);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(remainingDays, periodDays);

        return IntegerMath.DivideRoundHalfUp(amountMinor * remainingDays, periodDays);
    }

    /// <summary>
    /// Returns a credit line for every current charge followed by a charge line for every new charge,
    /// each prorated over the remaining days of the period and rounded on its own.
    /// </summary>
    public static IReadOnlyList<ProrationLine> Lines(
        IReadOnlyList<AdvanceCharge> current,
        IReadOnlyList<AdvanceCharge> next,
        int remainingDays,
        int periodDays) =>
        current.Select(charge => Line(charge, isCredit: true, remainingDays, periodDays))
            .Concat(next.Select(charge => Line(charge, isCredit: false, remainingDays, periodDays)))
            .ToList();

    /// <summary>Returns the sum of the line amounts, credits included.</summary>
    public static long Total(IEnumerable<ProrationLine> lines) => lines.Sum(l => l.AmountMinor);

    private static ProrationLine Line(AdvanceCharge charge, bool isCredit, int remainingDays, int periodDays)
    {
        var amount = isCredit ? -charge.AmountMinor : charge.AmountMinor;
        return new ProrationLine(charge.PlanItemId, isCredit, charge.Name, charge.BilledQuantity, Prorate(amount, remainingDays, periodDays));
    }
}
