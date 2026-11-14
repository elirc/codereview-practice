using Billing.Domain;
using Xunit;

namespace Billing.Domain.Tests;

public class BillingCalendarTests
{
    private static readonly TimeZoneInfo Auckland = BillingCalendar.FindZone("Pacific/Auckland");
    private static readonly TimeZoneInfo LosAngeles = BillingCalendar.FindZone("America/Los_Angeles");
    private static readonly TimeZoneInfo Santiago = BillingCalendar.FindZone("America/Santiago");
    private static readonly TimeZoneInfo Havana = BillingCalendar.FindZone("America/Havana");
    private static readonly TimeZoneInfo Utc = BillingCalendar.FindZone("Etc/UTC");

    [Theory]
    [InlineData(0, "2027-01-31")]
    [InlineData(1, "2027-02-28")]
    [InlineData(2, "2027-03-31")]
    [InlineData(3, "2027-04-30")]
    [InlineData(13, "2028-02-29")]
    public void AddMonthsClampedKeepsTheAnchorDayWhereTheMonthAllows(int months, string expected)
    {
        var anchor = new DateOnly(2027, 1, 31);

        Assert.Equal(DateOnly.Parse(expected), BillingCalendar.AddMonthsClamped(anchor, months));
    }

    [Fact]
    public void MonthlyPeriodsAnchoredOnTheLastDayOfJanuaryFollowMonthEnds()
    {
        var anchor = new DateOnly(2028, 1, 31);

        var starts = Enumerable.Range(0, 4)
            .Select(i => BillingCalendar.Period(anchor, BillingInterval.Month, i).Start)
            .ToList();

        Assert.Equal(
            new[] { new DateOnly(2028, 1, 31), new DateOnly(2028, 2, 29), new DateOnly(2028, 3, 31), new DateOnly(2028, 4, 30) },
            starts.ToArray());
    }

    [Fact]
    public void PeriodBoundariesAreComputedFromTheAnchorNotThePreviousBoundary()
    {
        var anchor = new DateOnly(2027, 1, 31);

        var third = BillingCalendar.Period(anchor, BillingInterval.Month, 2);

        Assert.Equal(new DateOnly(2027, 3, 31), third.Start);
        Assert.Equal(new DateOnly(2027, 4, 30), third.End);
        Assert.Equal(30, third.Days);
    }

    [Fact]
    public void YearlyPeriodsAnchoredOnLeapDayReturnToLeapDayInLeapYears()
    {
        var anchor = new DateOnly(2028, 2, 29);

        var ends = Enumerable.Range(0, 4)
            .Select(i => BillingCalendar.Period(anchor, BillingInterval.Year, i).End)
            .ToList();

        Assert.Equal(
            new[] { new DateOnly(2029, 2, 28), new DateOnly(2030, 2, 28), new DateOnly(2031, 2, 28), new DateOnly(2032, 2, 29) },
            ends.ToArray());
    }

    [Fact]
    public void StartOfDayIsLocalMidnightOnAnOrdinaryDay()
    {
        var start = BillingCalendar.StartOfDay(new DateOnly(2026, 3, 10), Auckland);

        Assert.Equal(new DateTimeOffset(2026, 3, 9, 11, 0, 0, TimeSpan.Zero), start);
    }

    [Fact]
    public void StartOfDayIsTheFirstValidInstantWhenMidnightIsSkipped()
    {
        var santiago = BillingCalendar.StartOfDay(new DateOnly(2024, 9, 8), Santiago);
        var havana = BillingCalendar.StartOfDay(new DateOnly(2024, 3, 10), Havana);

        Assert.Equal(new DateTimeOffset(2024, 9, 8, 4, 0, 0, TimeSpan.Zero), santiago);
        Assert.Equal(new DateTimeOffset(2024, 3, 10, 5, 0, 0, TimeSpan.Zero), havana);
    }

    [Fact]
    public void StartOfDayIsTheEarlierInstantWhenMidnightOccursTwice()
    {
        var start = BillingCalendar.StartOfDay(new DateOnly(2024, 11, 3), Havana);

        Assert.Equal(new DateTimeOffset(2024, 11, 3, 4, 0, 0, TimeSpan.Zero), start);
    }

    [Fact]
    public void StartOfDayInUtcIsMidnightUtc()
    {
        var start = BillingCalendar.StartOfDay(new DateOnly(2026, 7, 1), Utc);

        Assert.Equal(new DateTimeOffset(2026, 7, 1, 0, 0, 0, TimeSpan.Zero), start);
    }

    [Fact]
    public void TodayInLosAngelesAtTwoInTheMorningUtcIsThePreviousDate()
    {
        var now = new DateTimeOffset(2026, 6, 15, 2, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 6, 14), BillingCalendar.Today(now, LosAngeles));
        Assert.Equal(new DateOnly(2026, 6, 15), BillingCalendar.Today(now, Utc));
    }

    [Fact]
    public void TodayInAucklandIsAheadOfUtc()
    {
        var now = new DateTimeOffset(2026, 3, 9, 11, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 3, 10), BillingCalendar.Today(now, Auckland));
        Assert.Equal(new DateOnly(2026, 3, 9), BillingCalendar.Today(now.AddSeconds(-1), Auckland));
    }

    [Fact]
    public void PeriodSpanningADaylightSavingChangeCountsCivilDays()
    {
        var period = BillingCalendar.Period(new DateOnly(2026, 3, 1), BillingInterval.Month, 0);
        var instantSpan = BillingCalendar.StartOfDay(period.End, LosAngeles) - BillingCalendar.StartOfDay(period.Start, LosAngeles);

        Assert.Equal(31, period.Days);
        Assert.Equal(31, BillingCalendar.DaysBetween(period.Start, period.End));
        Assert.Equal(TimeSpan.FromDays(31) - TimeSpan.FromHours(1), instantSpan);
    }

    [Theory]
    [InlineData("Pacific/Auckland", true)]
    [InlineData("Not/AZone", false)]
    [InlineData("", false)]
    public void TryFindZoneAcceptsOnlyKnownIanaIds(string id, bool expected)
    {
        Assert.Equal(expected, BillingCalendar.TryFindZone(id, out _));
    }
}
