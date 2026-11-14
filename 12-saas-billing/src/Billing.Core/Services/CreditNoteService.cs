using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Views;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Services;

public sealed record CreditNoteLineInput(Guid InvoiceLineId, long AmountMinor);

public sealed record NewCreditNote(IReadOnlyList<CreditNoteLineInput> Lines, string Reason, CreditNoteDisposition Disposition);

public sealed record CreditTransactionView(
    Guid Id,
    long AmountMinor,
    CreditTransactionKind Kind,
    Guid? InvoiceId,
    Guid? CreditNoteId,
    string? Description,
    long BalanceAfterMinor,
    DateTimeOffset CreatedAt)
{
    public static CreditTransactionView From(CreditBalanceTransaction t) =>
        new(t.Id, t.AmountMinor, t.Kind, t.InvoiceId, t.CreditNoteId, t.Description, t.BalanceAfterMinor, t.CreatedAt);
}

/// <summary>Issues credit notes against finalised invoices and adjusts customer credit balances.</summary>
public sealed class CreditNoteService(
    BillingDbContext db,
    TimeProvider clock,
    CreditLedger ledger,
    DocumentNumberer numbers,
    InvoiceService invoices,
    InvoiceSettlement settlement,
    EventRecorder events,
    ViewLoader views,
    ILogger<CreditNoteService> logger)
{
    /// <summary>
    /// Credits lines of an open or paid invoice: an open invoice's amount due is reduced, a paid invoice's credit
    /// goes to the customer's balance or is refunded to the payment method.
    /// </summary>
    public Task<CreditNoteView> CreateAsync(Guid invoiceId, NewCreditNote input, Guid createdByKeyId, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var locked = await db.LockInvoiceWithSubscriptionAsync(invoiceId, ct) ?? throw DomainException.NotFound("Invoice");
                var invoice = locked.Invoice;
                if (invoice.Status is not (InvoiceStatus.Open or InvoiceStatus.Paid))
                {
                    throw DomainException.InvalidState("Only open or paid invoices can be credited.");
                }

                await invoices.EnsureNoPaymentInProgressAsync(invoiceId, ct);
                var customer = await db.LockCustomerAsync(invoice.CustomerId, ct)
                    ?? throw new InvalidOperationException($"Customer {invoice.CustomerId} does not exist.");

                var invoiceLines = await db.InvoiceLines.Where(l => l.InvoiceId == invoiceId).ToDictionaryAsync(l => l.Id, ct);
                var note = new CreditNote
                {
                    Id = Ids.New(clock),
                    InvoiceId = invoiceId,
                    Reason = input.Reason,
                    Disposition = input.Disposition,
                    CreatedByKeyId = createdByKeyId,
                    CreatedAt = clock.GetUtcNow(),
                };

                for (var i = 0; i < input.Lines.Count; i++)
                {
                    var request = input.Lines[i];
                    if (!invoiceLines.TryGetValue(request.InvoiceLineId, out var line))
                    {
                        throw DomainException.Validation($"lines[{i}].invoiceLineId", "Is not a line of this invoice.");
                    }

                    if (request.AmountMinor > line.AmountMinor - line.CreditedMinor)
                    {
                        throw DomainException.Unprocessable(
                            ErrorCodes.ExceedsCreditable,
                            "The credit exceeds the line's remaining creditable amount.",
                            new { invoiceLineId = line.Id, creditableMinor = Math.Max(0, line.AmountMinor - line.CreditedMinor) });
                    }

                    var tax = CreditNoteMath.LineTax(request.AmountMinor, line.AmountMinor, line.CreditedMinor, line.TaxMinor, line.CreditedTaxMinor, line.TaxRateBps);
                    line.CreditedMinor += request.AmountMinor;
                    line.CreditedTaxMinor += tax;
                    note.Lines.Add(new CreditNoteLine { CreditNoteId = note.Id, InvoiceLineId = line.Id, AmountMinor = request.AmountMinor, TaxMinor = tax });
                }

                note.SubtotalMinor = note.Lines.Sum(l => l.AmountMinor);
                note.TaxMinor = note.Lines.Sum(l => l.TaxMinor);
                note.TotalMinor = note.SubtotalMinor + note.TaxMinor;

                ApplyDisposition(invoice, customer, note);
                invoice.CreditedMinor += note.TotalMinor;

                var issueYear = BillingCalendar.Today(clock.GetUtcNow(), BillingCalendar.FindZone(customer.Timezone)).Year;
                note.Number = await numbers.NextAsync(CounterName.CreditNote, issueYear, ct);
                db.CreditNotes.Add(note);
                await db.SaveChangesAsync(ct);
                logger.LogInformation(
                    "Credit note {Number} of {TotalMinor} ({Disposition}) issued against invoice {InvoiceId}",
                    note.Number,
                    note.TotalMinor,
                    note.Disposition,
                    invoiceId);

                if (invoice.Status == InvoiceStatus.Open && invoice.AmountRemainingMinor == 0)
                {
                    await settlement.MarkPaidAsync(invoice, locked.Subscription, ct);
                }

                var view = await views.CreditNoteAsync(note.Id, ct) ?? throw DomainException.NotFound("Credit note");
                await events.RecordAsync(EventTypes.CreditNoteCreated, "credit_note", note.Id, view, null, ct);
                return view;
            },
            ct);

    public async Task<CreditNoteView> GetAsync(Guid id, CancellationToken ct) =>
        await views.CreditNoteAsync(id, ct) ?? throw DomainException.NotFound("Credit note");

    /// <summary>Adds a signed manual adjustment to the customer's credit balance.</summary>
    public Task<CreditTransactionView> AdjustCreditAsync(Guid customerId, long amountMinor, string reason, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var customer = await db.LockCustomerAsync(customerId, ct) ?? throw DomainException.NotFound("Customer");
                var transaction = ledger.Post(customer, amountMinor, CreditTransactionKind.ManualAdjustment, description: reason);
                await db.SaveChangesAsync(ct);
                logger.LogInformation(
                    "Credit balance of customer {CustomerId} adjusted by {AmountMinor} to {BalanceMinor}",
                    customerId,
                    amountMinor,
                    customer.CreditBalanceMinor);
                return CreditTransactionView.From(transaction);
            },
            ct);

    public async Task<Page<CreditTransactionView>> ListCreditTransactionsAsync(Guid customerId, PageRequest page, CancellationToken ct)
    {
        if (!await db.Customers.AnyAsync(c => c.Id == customerId, ct))
        {
            throw DomainException.NotFound("Customer");
        }

        IQueryable<CreditBalanceTransaction> source = page.AfterId() is { } after
            ? db.CreditBalanceTransactions.FromSql($"SELECT * FROM credit_balance_transactions WHERE id > {after}")
            : db.CreditBalanceTransactions;
        var rows = await source.AsNoTracking()
            .Where(t => t.CustomerId == customerId)
            .OrderBy(t => t.Id)
            .Take(page.Limit + 1)
            .ToListAsync(ct);
        return Paging.Build(rows, page.Limit, t => t.Id.ToString(), CreditTransactionView.From);
    }

    private void ApplyDisposition(Invoice invoice, Customer customer, CreditNote note)
    {
        if (invoice.Status == InvoiceStatus.Open)
        {
            if (note.Disposition != CreditNoteDisposition.ReduceDue)
            {
                throw DomainException.InvalidState("Credit notes on an open invoice must reduce the amount due.");
            }

            if (note.TotalMinor > invoice.AmountRemainingMinor)
            {
                throw DomainException.Unprocessable(ErrorCodes.ExceedsRemaining, "The credit exceeds the invoice's remaining amount.");
            }

            invoice.AmountRemainingMinor -= note.TotalMinor;
            return;
        }

        switch (note.Disposition)
        {
            case CreditNoteDisposition.CreditBalance:
                ledger.Post(customer, note.TotalMinor, CreditTransactionKind.CreditNote, invoiceId: invoice.Id, creditNoteId: note.Id);
                break;

            case CreditNoteDisposition.Refund:
                if (note.TotalMinor > invoice.AmountPaidMinor - invoice.RefundedMinor)
                {
                    throw DomainException.Unprocessable(ErrorCodes.ExceedsRefundable, "The refund exceeds the amount paid less earlier refunds.");
                }

                invoice.RefundedMinor += note.TotalMinor;
                note.RefundStatus = RefundStatus.Pending;
                break;

            default:
                throw DomainException.InvalidState("A paid invoice is credited to the customer's balance or refunded.");
        }
    }
}
