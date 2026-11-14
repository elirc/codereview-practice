namespace Billing.Core.Data;

public sealed class Invoice
{
    public Guid Id { get; set; }

    public string? Number { get; set; }

    public Guid CustomerId { get; set; }

    public Guid? SubscriptionId { get; set; }

    public InvoiceKind Kind { get; set; }

    public DateOnly? PeriodStart { get; set; }

    public DateOnly? PeriodEnd { get; set; }

    public InvoiceStatus Status { get; set; }

    public string Currency { get; set; } = string.Empty;

    public long SubtotalMinor { get; set; }

    public long TaxMinor { get; set; }

    public long TotalMinor { get; set; }

    public long CreditAppliedMinor { get; set; }

    public long AmountDueMinor { get; set; }

    public long AmountPaidMinor { get; set; }

    public long CreditedMinor { get; set; }

    public long RefundedMinor { get; set; }

    public long AmountRemainingMinor { get; set; }

    public DateOnly? IssueDate { get; set; }

    public DateTimeOffset? FinalizedAt { get; set; }

    public DateTimeOffset? PaidAt { get; set; }

    public string? BillToName { get; set; }

    public string? BillToEmail { get; set; }

    public string? BillToCountry { get; set; }

    public string? BillToRegion { get; set; }

    public bool BillToTaxExempt { get; set; }

    public int DeclineCount { get; set; }

    public int AttemptCount { get; set; }

    public DateTimeOffset? NextPaymentAttemptAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public List<InvoiceLine> Lines { get; set; } = [];
}

public sealed class InvoiceLine
{
    public Guid Id { get; set; }

    public Guid InvoiceId { get; set; }

    public int LineNo { get; set; }

    public InvoiceLineKind Kind { get; set; }

    public string Description { get; set; } = string.Empty;

    public Guid? PlanItemId { get; set; }

    public long Quantity { get; set; }

    public long AmountMinor { get; set; }

    public int TaxRateBps { get; set; }

    public long TaxMinor { get; set; }

    public DateOnly? PeriodStart { get; set; }

    public DateOnly? PeriodEnd { get; set; }

    public long CreditedMinor { get; set; }

    public long CreditedTaxMinor { get; set; }
}

public sealed class PaymentAttempt
{
    public Guid Id { get; set; }

    public Guid InvoiceId { get; set; }

    public int AttemptNo { get; set; }

    public string IdempotencyKey { get; set; } = string.Empty;

    public long AmountMinor { get; set; }

    public PaymentAttemptStatus Status { get; set; }

    public string? GatewayChargeId { get; set; }

    public string? FailureCode { get; set; }

    public bool CountsAsDecline { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset? CompletedAt { get; set; }
}

public sealed class CreditNote
{
    public Guid Id { get; set; }

    public string Number { get; set; } = string.Empty;

    public Guid InvoiceId { get; set; }

    public string Reason { get; set; } = string.Empty;

    public CreditNoteDisposition Disposition { get; set; }

    public long SubtotalMinor { get; set; }

    public long TaxMinor { get; set; }

    public long TotalMinor { get; set; }

    public RefundStatus? RefundStatus { get; set; }

    public int RefundAttempts { get; set; }

    public Guid CreatedByKeyId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public List<CreditNoteLine> Lines { get; set; } = [];
}

public sealed class CreditNoteLine
{
    public Guid CreditNoteId { get; set; }

    public Guid InvoiceLineId { get; set; }

    public long AmountMinor { get; set; }

    public long TaxMinor { get; set; }
}
