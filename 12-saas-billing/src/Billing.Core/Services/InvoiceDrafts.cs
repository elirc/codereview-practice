using Billing.Core.Data;

namespace Billing.Core.Services;

/// <summary>Builds draft invoices and their lines.</summary>
public static class InvoiceDrafts
{
    /// <summary>Returns a new draft invoice; the caller adds it to the context.</summary>
    public static Invoice New(
        TimeProvider clock,
        Guid customerId,
        string currency,
        InvoiceKind kind,
        Guid? subscriptionId = null,
        DateOnly? periodStart = null,
        DateOnly? periodEnd = null) => new()
        {
            Id = Ids.New(clock),
            CustomerId = customerId,
            SubscriptionId = subscriptionId,
            Kind = kind,
            PeriodStart = periodStart,
            PeriodEnd = periodEnd,
            Status = InvoiceStatus.Draft,
            Currency = currency,
            CreatedAt = clock.GetUtcNow(),
        };

    /// <summary>Appends a line numbered after the invoice's existing lines and returns it.</summary>
    public static InvoiceLine AddLine(
        this Invoice invoice,
        TimeProvider clock,
        InvoiceLineKind kind,
        string description,
        long quantity,
        long amountMinor,
        Guid? planItemId = null,
        DateOnly? periodStart = null,
        DateOnly? periodEnd = null)
    {
        var line = new InvoiceLine
        {
            Id = Ids.New(clock),
            InvoiceId = invoice.Id,
            LineNo = invoice.Lines.Count == 0 ? 1 : invoice.Lines.Max(l => l.LineNo) + 1,
            Kind = kind,
            Description = description,
            PlanItemId = planItemId,
            Quantity = quantity,
            AmountMinor = amountMinor,
            PeriodStart = periodStart,
            PeriodEnd = periodEnd,
        };
        invoice.Lines.Add(line);
        return line;
    }
}
