using System.Diagnostics.CodeAnalysis;

namespace Billing.Domain;

/// <summary>One billing period as civil dates, <c>[Start, End)</c>.</summary>
public readonly record struct BillingPeriod(int Index, DateOnly Start, DateOnly End)
{
    public int Days => End.DayNumber - Start.DayNumber;
}

/// <summary>Civil-date and time-zone calculations for billing periods.</summary>
public static class BillingCalendar
{
    /// <summary>Moves <paramref name="months"/> months from the anchor and clamps the day to the target month's length.</summary>
    public static DateOnly AddMonthsClamped(DateOnly anchor, int months)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(months);

        var monthIndex = (anchor.Year * 12) + (anchor.Month - 1) + months;
        var year = monthIndex / 12;
        var month = (monthIndex % 12) + 1;
        var day = Math.Min(anchor.Day, DateTime.DaysInMonth(year, month));
        return new DateOnly(year, month, day);
    }

    /// <summary>Returns period <paramref name="index"/> of a subscription anchored on <paramref name="anchor"/>.</summary>
    public static BillingPeriod Period(DateOnly anchor, BillingInterval interval, int index)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(index);

        var step = MonthsPerPeriod(interval);
        return new BillingPeriod(index, AddMonthsClamped(anchor, step * index), AddMonthsClamped(anchor, step * (index + 1)));
    }

    /// <summary>Returns the number of months in one period of the interval.</summary>
    public static int MonthsPerPeriod(BillingInterval interval) => interval switch
    {
        BillingInterval.Month => 1,
        BillingInterval.Year => 12,
        _ => throw new ArgumentOutOfRangeException(nameof(interval)),
    };

    /// <summary>
    /// Returns the instant at which <paramref name="date"/> begins in <paramref name="zone"/>: local midnight,
    /// the first valid local time when midnight is skipped, or the earlier instant when midnight occurs twice.
    /// </summary>
    public static DateTimeOffset StartOfDay(DateOnly date, TimeZoneInfo zone)
    {
        var midnight = date.ToDateTime(TimeOnly.MinValue, DateTimeKind.Unspecified);

        if (zone.IsAmbiguousTime(midnight))
        {
            var offsets = zone.GetAmbiguousTimeOffsets(midnight);
            return ToInstant(midnight, offsets.Max());
        }

        var local = midnight;
        var nextDay = midnight.AddDays(1);
        while (zone.IsInvalidTime(local) && local < nextDay)
        {
            local = local.AddMinutes(1);
        }

        return ToInstant(local, zone.GetUtcOffset(local));
    }

    /// <summary>Returns the civil date in <paramref name="zone"/> at the instant <paramref name="now"/>.</summary>
    public static DateOnly Today(DateTimeOffset now, TimeZoneInfo zone) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, zone).DateTime);

    /// <summary>Returns the number of civil days from <paramref name="from"/> to <paramref name="to"/>.</summary>
    public static int DaysBetween(DateOnly from, DateOnly to) => to.DayNumber - from.DayNumber;

    /// <summary>Finds a time zone by IANA id; returns false for unknown or non-IANA ids.</summary>
    public static bool TryFindZone(string? ianaId, [NotNullWhen(true)] out TimeZoneInfo? zone)
    {
        zone = null;
        if (string.IsNullOrWhiteSpace(ianaId))
        {
            return false;
        }

        if (!TimeZoneInfo.TryFindSystemTimeZoneById(ianaId, out var found) || !found.HasIanaId)
        {
            return false;
        }

        zone = found;
        return true;
    }

    /// <summary>Finds a time zone by IANA id; throws when it does not exist.</summary>
    public static TimeZoneInfo FindZone(string ianaId) =>
        TryFindZone(ianaId, out var zone)
            ? zone
            : throw new ArgumentException($"Unknown IANA time zone \"{ianaId}\".", nameof(ianaId));

    private static DateTimeOffset ToInstant(DateTime local, TimeSpan offset) =>
        new(DateTime.SpecifyKind(local - offset, DateTimeKind.Unspecified), TimeSpan.Zero);
}
