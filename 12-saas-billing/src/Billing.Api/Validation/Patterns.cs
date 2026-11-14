using System.Text.RegularExpressions;

namespace Billing.Api.Validation;

/// <summary>Regular expressions shared by the request validators.</summary>
public static partial class Patterns
{
    [GeneratedRegex("^[A-Z]{2}$")]
    public static partial Regex Country();

    [GeneratedRegex(@"^[^@\s]+@[^@\s]+\.[^@\s]+$")]
    public static partial Regex Email();

    [GeneratedRegex("^[a-z0-9][a-z0-9_-]{0,63}$")]
    public static partial Regex Code();
}
