namespace Billing.Domain;

/// <summary>The ISO-4217 currencies the platform bills in; all use two minor-unit digits.</summary>
public static class Currencies
{
    public static IReadOnlyList<string> Supported { get; } = ["USD", "EUR", "GBP"];

    /// <summary>Returns whether the code is one of the supported currencies.</summary>
    public static bool IsSupported(string? code) => code is not null && Supported.Contains(code, StringComparer.Ordinal);
}
