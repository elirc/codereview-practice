using Billing.Domain;
using Xunit;

namespace Billing.Domain.Tests;

public class ProrationTests
{
    private static readonly Guid OldItem = Guid.Parse("00000000-0000-0000-0000-000000000001");
    private static readonly Guid NewItem = Guid.Parse("00000000-0000-0000-0000-000000000002");

    [Theory]
    [InlineData(3000, 10, 31, 968)]
    [InlineData(5000, 10, 31, 1613)]
    [InlineData(3000, 15, 30, 1500)]
    [InlineData(1000, 1, 3, 333)]
    [InlineData(1000, 2, 3, 667)]
    [InlineData(1, 1, 2, 1)]
    public void ProrateRoundsHalfUp(long amount, int remaining, int days, long expected)
    {
        Assert.Equal(expected, Proration.Prorate(amount, remaining, days));
    }

    [Fact]
    public void UpgradeCreditsTheOldPlanAndChargesTheNewOneRoundingEachLine()
    {
        var current = new[] { new AdvanceCharge(OldItem, PlanItemKind.Flat, "Basic", 3000, 1) };
        var next = new[] { new AdvanceCharge(NewItem, PlanItemKind.Flat, "Pro", 5000, 1) };

        var lines = Proration.Lines(current, next, 10, 31);

        Assert.Collection(
            lines,
            credit =>
            {
                Assert.True(credit.IsCredit);
                Assert.Equal(-968, credit.AmountMinor);
            },
            charge =>
            {
                Assert.False(charge.IsCredit);
                Assert.Equal(1613, charge.AmountMinor);
            });
    }

    [Fact]
    public void SeatIncreaseProratesTheSeatAmountAtBothQuantities()
    {
        var current = new[] { new AdvanceCharge(OldItem, PlanItemKind.PerSeat, "Seats", 1000, 3) };
        var next = new[] { new AdvanceCharge(OldItem, PlanItemKind.PerSeat, "Seats", 1000, 5) };

        var lines = Proration.Lines(current, next, 15, 30);

        Assert.Equal(new long[] { -1500, 2500 }, lines.Select(l => l.AmountMinor).ToArray());
        Assert.Equal(new long[] { 3, 5 }, lines.Select(l => l.Quantity).ToArray());
    }

    [Fact]
    public void ChangeOnTheFirstDayOfThePeriodUsesFullAmounts()
    {
        var current = new[] { new AdvanceCharge(OldItem, PlanItemKind.Flat, "Basic", 3000, 1) };
        var next = new[] { new AdvanceCharge(NewItem, PlanItemKind.Flat, "Pro", 5000, 1) };

        var lines = Proration.Lines(current, next, 31, 31);

        Assert.Equal(new long[] { -3000, 5000 }, lines.Select(l => l.AmountMinor).ToArray());
    }

    [Fact]
    public void ChangeOnTheLastDayOfThePeriodProratesOneDay()
    {
        var current = new[] { new AdvanceCharge(OldItem, PlanItemKind.Flat, "Basic", 3000, 1) };
        var next = new[] { new AdvanceCharge(NewItem, PlanItemKind.Flat, "Pro", 5000, 1) };

        var lines = Proration.Lines(current, next, 1, 30);

        Assert.Equal(new long[] { -100, 167 }, lines.Select(l => l.AmountMinor).ToArray());
    }

    [Fact]
    public void RecurringAddsFlatAmountsAndSeatTotals()
    {
        var charges = new[]
        {
            new AdvanceCharge(OldItem, PlanItemKind.Flat, "Platform", 2000, 1),
            new AdvanceCharge(NewItem, PlanItemKind.PerSeat, "Seats", 1000, 4),
        };

        Assert.Equal(6000, Proration.Recurring(charges));
    }

    [Fact]
    public void ProrateRejectsMoreRemainingDaysThanThePeriodHas()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => Proration.Prorate(1000, 31, 30));
    }
}
