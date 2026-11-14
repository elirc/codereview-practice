using System.Globalization;

namespace Billing.Domain;

/// <summary>Formats invoice and credit-note numbers.</summary>
public static class DocumentNumbers
{
    public const string InvoicePrefix = "INV";
    public const string CreditNotePrefix = "CN";

    /// <summary>Returns <c>&lt;prefix&gt;-&lt;year&gt;-&lt;6 digits&gt;</c>.</summary>
    public static string Format(string prefix, int year, long sequence)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(sequence);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(sequence, 999_999);
        return string.Create(CultureInfo.InvariantCulture, $"{prefix}-{year:D4}-{sequence:D6}");
    }
}
