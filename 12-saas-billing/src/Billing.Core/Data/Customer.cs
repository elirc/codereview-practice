namespace Billing.Core.Data;

public sealed class Customer
{
    public Guid Id { get; set; }

    public string ExternalId { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string Email { get; set; } = string.Empty;

    public string Currency { get; set; } = string.Empty;

    public string Timezone { get; set; } = string.Empty;

    public string Country { get; set; } = string.Empty;

    public string? Region { get; set; }

    public bool TaxExempt { get; set; }

    public string? PaymentMethodToken { get; set; }

    public long CreditBalanceMinor { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class CreditBalanceTransaction
{
    public Guid Id { get; set; }

    public Guid CustomerId { get; set; }

    public long AmountMinor { get; set; }

    public CreditTransactionKind Kind { get; set; }

    public Guid? InvoiceId { get; set; }

    public Guid? CreditNoteId { get; set; }

    public string? Description { get; set; }

    public long BalanceAfterMinor { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class Counter
{
    public CounterName Name { get; set; }

    public int Year { get; set; }

    public long Next { get; set; }
}
