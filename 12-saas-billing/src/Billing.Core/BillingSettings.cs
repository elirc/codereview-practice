using System.Globalization;

namespace Billing.Core;

/// <summary>Process configuration read from environment variables at start-up.</summary>
public sealed record BillingSettings
{
    public static readonly IReadOnlyList<string> AllLoops =
        ["billing", "payments", "refunds", "webhook-fanout", "webhook-delivery", "purge"];

    public required string ConnectionString { get; init; }

    public int Port { get; init; } = 8120;

    public int UsageGraceMinutes { get; init; } = 60;

    public int UsageMaxAgeDays { get; init; } = 35;

    public bool WebhookAllowHttp { get; init; }

    public string PaymentGateway { get; init; } = "fake";

    public IReadOnlySet<string> WorkerLoops { get; init; } = new HashSet<string>(AllLoops);

    public TimeSpan UsageGrace => TimeSpan.FromMinutes(UsageGraceMinutes);

    public TimeSpan UsageMaxAge => TimeSpan.FromDays(UsageMaxAgeDays);

    /// <summary>Reads and validates every setting; throws when any value is missing or invalid.</summary>
    public static BillingSettings Load(Func<string, string?> read)
    {
        var errors = new List<string>();

        var connectionString = string.Empty;
        var databaseUrl = read("DATABASE_URL");
        if (string.IsNullOrWhiteSpace(databaseUrl))
        {
            errors.Add("DATABASE_URL is required.");
        }
        else if (!TryParseDatabaseUrl(databaseUrl.Trim(), out connectionString))
        {
            errors.Add("DATABASE_URL must be a postgres:// URL or an Npgsql connection string.");
        }

        var settings = new BillingSettings
        {
            ConnectionString = connectionString,
            Port = ReadInt(read, "PORT", 8120, 1, 65535, errors),
            UsageGraceMinutes = ReadInt(read, "USAGE_GRACE_MINUTES", 60, 0, 24 * 60, errors),
            UsageMaxAgeDays = ReadInt(read, "USAGE_MAX_AGE_DAYS", 35, 1, 366, errors),
            WebhookAllowHttp = ReadBool(read, "WEBHOOK_ALLOW_HTTP", false, errors),
            PaymentGateway = ReadGateway(read, errors),
            WorkerLoops = ReadLoops(read, errors),
        };

        if (errors.Count > 0)
        {
            throw new InvalidOperationException("Invalid configuration: " + string.Join(" ", errors));
        }

        return settings;
    }

    /// <summary>Converts a postgres:// URL to an Npgsql connection string; other values are returned as given.</summary>
    public static bool TryParseDatabaseUrl(string value, out string connectionString)
    {
        if (!value.StartsWith("postgres://", StringComparison.Ordinal)
            && !value.StartsWith("postgresql://", StringComparison.Ordinal))
        {
            connectionString = value;
            return value.Contains('=');
        }

        connectionString = string.Empty;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.Host))
        {
            return false;
        }

        var userInfo = uri.UserInfo.Split(':', 2);
        var user = Uri.UnescapeDataString(userInfo[0]);
        var password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : string.Empty;
        var database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/'));
        var port = uri.Port > 0 ? uri.Port : 5432;
        if (user.Length == 0 || database.Length == 0)
        {
            return false;
        }

        connectionString = string.Create(
            CultureInfo.InvariantCulture,
            $"Host={uri.Host};Port={port};Database={database};Username={user};Password={password}");
        return true;
    }

    private static int ReadInt(Func<string, string?> read, string name, int fallback, int min, int max, List<string> errors)
    {
        var raw = read(name);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        if (!int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || value < min || value > max)
        {
            errors.Add($"{name} must be an integer between {min} and {max}.");
            return fallback;
        }

        return value;
    }

    private static bool ReadBool(Func<string, string?> read, string name, bool fallback, List<string> errors)
    {
        var raw = read(name);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        if (!bool.TryParse(raw, out var value))
        {
            errors.Add($"{name} must be true or false.");
            return fallback;
        }

        return value;
    }

    private static string ReadGateway(Func<string, string?> read, List<string> errors)
    {
        var raw = read("PAYMENT_GATEWAY");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return "fake";
        }

        if (raw != "fake")
        {
            errors.Add("PAYMENT_GATEWAY must be \"fake\".");
        }

        return raw;
    }

    private static HashSet<string> ReadLoops(Func<string, string?> read, List<string> errors)
    {
        var raw = read("WORKER_LOOPS");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return new HashSet<string>(AllLoops);
        }

        var loops = raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet();
        foreach (var loop in loops.Where(l => !AllLoops.Contains(l)))
        {
            errors.Add($"WORKER_LOOPS contains an unknown loop \"{loop}\".");
        }

        return loops;
    }
}
