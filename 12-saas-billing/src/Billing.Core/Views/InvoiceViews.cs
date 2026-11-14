using Billing.Core.Data;

namespace Billing.Core.Views;

public sealed record BillToView(string? Name, string? Email, string? Country, string? Region, bool TaxExempt);

public sealed record InvoiceLineView(
    Guid Id,
    int LineNo,
    InvoiceLineKind Kind,
    string Description,
    Guid? PlanItemId,
    long Quantity,
    long AmountMinor,
    int TaxRateBps,
    long TaxMinor,
    DateOnly? PeriodStart,
    DateOnly? PeriodEnd,
    long CreditedMinor,
    long CreditedTaxMinor)
{
    public static InvoiceLineView From(InvoiceLine l) => new(
        l.Id,
        l.LineNo,
        l.Kind,
        l.Description,
        l.PlanItemId,
        l.Quantity,
        l.AmountMinor,
        l.TaxRateBps,
        l.TaxMinor,
        l.PeriodStart,
        l.PeriodEnd,
        l.CreditedMinor,
        l.CreditedTaxMinor);
}

public sealed record PaymentAttemptView(
    Guid Id,
    int AttemptNo,
    long AmountMinor,
    PaymentAttemptStatus Status,
    string? GatewayChargeId,
    string? FailureCode,
    bool CountsAsDecline,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt)
{
    public static PaymentAttemptView From(PaymentAttempt a) => new(
        a.Id,
        a.AttemptNo,
        a.AmountMinor,
        a.Status,
        a.GatewayChargeId,
        a.FailureCode,
        a.CountsAsDecline,
        a.CreatedAt,
        a.CompletedAt);
}

public sealed record CreditNoteLineView(Guid InvoiceLineId, long AmountMinor, long TaxMinor);

public sealed record CreditNoteView(
    Guid Id,
    string Number,
    Guid InvoiceId,
    string Reason,
    CreditNoteDisposition Disposition,
    long SubtotalMinor,
    long TaxMinor,
    long TotalMinor,
    RefundStatus? RefundStatus,
    DateTimeOffset CreatedAt,
    IReadOnlyList<CreditNoteLineView> Lines)
{
    public static CreditNoteView From(CreditNote n) => new(
        n.Id,
        n.Number,
        n.InvoiceId,
        n.Reason,
        n.Disposition,
        n.SubtotalMinor,
        n.TaxMinor,
        n.TotalMinor,
        n.RefundStatus,
        n.CreatedAt,
        n.Lines.OrderBy(l => l.InvoiceLineId).Select(l => new CreditNoteLineView(l.InvoiceLineId, l.AmountMinor, l.TaxMinor)).ToList());
}

public sealed record InvoiceView(
    Guid Id,
    string? Number,
    Guid CustomerId,
    Guid? SubscriptionId,
    InvoiceKind Kind,
    DateOnly? PeriodStart,
    DateOnly? PeriodEnd,
    InvoiceStatus Status,
    string Currency,
    long SubtotalMinor,
    long TaxMinor,
    long TotalMinor,
    long CreditAppliedMinor,
    long AmountDueMinor,
    long AmountPaidMinor,
    long CreditedMinor,
    long RefundedMinor,
    long AmountRemainingMinor,
    DateOnly? IssueDate,
    DateTimeOffset? FinalizedAt,
    DateTimeOffset? PaidAt,
    BillToView? BillTo,
    int DeclineCount,
    int AttemptCount,
    DateTimeOffset? NextPaymentAttemptAt,
    DateTimeOffset CreatedAt,
    IReadOnlyList<InvoiceLineView> Lines,
    IReadOnlyList<PaymentAttemptView> Attempts,
    IReadOnlyList<CreditNoteView> CreditNotes)
{
    public static InvoiceView From(
        Invoice i,
        IEnumerable<PaymentAttempt> attempts,
        IEnumerable<CreditNote> creditNotes) => new(
        i.Id,
        i.Number,
        i.CustomerId,
        i.SubscriptionId,
        i.Kind,
        i.PeriodStart,
        i.PeriodEnd,
        i.Status,
        i.Currency,
        i.SubtotalMinor,
        i.TaxMinor,
        i.TotalMinor,
        i.CreditAppliedMinor,
        i.AmountDueMinor,
        i.AmountPaidMinor,
        i.CreditedMinor,
        i.RefundedMinor,
        i.AmountRemainingMinor,
        i.IssueDate,
        i.FinalizedAt,
        i.PaidAt,
        i.Status == InvoiceStatus.Draft
            ? null
            : new BillToView(i.BillToName, i.BillToEmail, i.BillToCountry, i.BillToRegion, i.BillToTaxExempt),
        i.DeclineCount,
        i.AttemptCount,
        i.NextPaymentAttemptAt,
        i.CreatedAt,
        i.Lines.OrderBy(l => l.LineNo).Select(InvoiceLineView.From).ToList(),
        attempts.OrderBy(a => a.AttemptNo).Select(PaymentAttemptView.From).ToList(),
        creditNotes.OrderBy(n => n.CreatedAt).ThenBy(n => n.Number).Select(CreditNoteView.From).ToList());
}
