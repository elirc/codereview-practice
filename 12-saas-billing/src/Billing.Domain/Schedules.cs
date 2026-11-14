namespace Billing.Domain;

/// <summary>When a declined invoice is attempted again.</summary>
public static class DunningSchedule
{
    public const int MaxDeclines = 4;

    /// <summary>Returns the wait before the next attempt after <paramref name="declineCount"/> declines, or null when collection stops.</summary>
    public static TimeSpan? RetryDelay(int declineCount)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(declineCount);
        return declineCount switch
        {
            1 => TimeSpan.FromDays(3),
            2 => TimeSpan.FromDays(5),
            3 => TimeSpan.FromDays(7),
            _ => null,
        };
    }
}

/// <summary>When a webhook delivery is attempted again.</summary>
public static class WebhookRetrySchedule
{
    public const int MaxAttempts = 8;

    private static readonly TimeSpan[] Delays =
    [
        TimeSpan.FromMinutes(1),
        TimeSpan.FromMinutes(5),
        TimeSpan.FromMinutes(30),
        TimeSpan.FromHours(2),
        TimeSpan.FromHours(6),
        TimeSpan.FromHours(12),
        TimeSpan.FromHours(24),
    ];

    /// <summary>Returns the wait before the next attempt after <paramref name="failedAttempts"/> failures, or null when the delivery has failed for good.</summary>
    public static TimeSpan? RetryDelay(int failedAttempts)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(failedAttempts);
        return failedAttempts < MaxAttempts ? Delays[failedAttempts - 1] : null;
    }
}
