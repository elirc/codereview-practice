namespace Billing.IntegrationTests.Infrastructure;

/// <summary>A clock that only moves when a test moves it.</summary>
public sealed class ManualTimeProvider(DateTimeOffset start) : TimeProvider
{
    private readonly object _gate = new();
    private DateTimeOffset _now = start;

    public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.Utc;

    public override DateTimeOffset GetUtcNow()
    {
        lock (_gate)
        {
            return _now;
        }
    }

    public void Set(DateTimeOffset now)
    {
        lock (_gate)
        {
            _now = now.ToUniversalTime();
        }
    }

    public void Advance(TimeSpan by)
    {
        lock (_gate)
        {
            _now = _now.Add(by);
        }
    }
}
