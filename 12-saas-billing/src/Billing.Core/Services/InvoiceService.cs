using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Views;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Services;

/// <summary>One line of a manual invoice.</summary>
public sealed record ManualLine(string Description, long Quantity, long UnitAmountMinor);

/// <summary>Manual invoices, finalisation on request, voiding and invoice queries.</summary>
public sealed class InvoiceService(
    BillingDbContext db,
    TimeProvider clock,
    InvoiceFinalizer finalizer,
    CreditLedger ledger,
    EventRecorder events,
    ViewLoader views,
    ILogger<InvoiceService> logger)
{
    /// <summary>Creates a draft manual invoice in the customer's currency.</summary>
    public async Task<InvoiceView> CreateDraftAsync(Guid customerId, IReadOnlyList<ManualLine> lines, CancellationToken ct)
    {
        var customer = await db.Customers.AsNoTracking().SingleOrDefaultAsync(c => c.Id == customerId, ct)
            ?? throw DomainException.NotFound("Customer");

        var invoice = InvoiceDrafts.New(clock, customer.Id, customer.Currency, InvoiceKind.Manual);
        AddManualLines(invoice, lines);
        db.Invoices.Add(invoice);
        await db.SaveChangesAsync(ct);
        return await GetAsync(invoice.Id, ct);
    }

    /// <summary>Replaces every line of a draft manual invoice.</summary>
    public Task<InvoiceView> ReplaceLinesAsync(Guid invoiceId, IReadOnlyList<ManualLine> lines, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var invoice = await db.LockInvoiceAsync(invoiceId, ct) ?? throw DomainException.NotFound("Invoice");
                if (invoice.Status != InvoiceStatus.Draft || invoice.Kind != InvoiceKind.Manual)
                {
                    throw DomainException.InvalidState("Only the lines of a draft manual invoice can be changed.");
                }

                await db.InvoiceLines.Where(l => l.InvoiceId == invoiceId).ExecuteDeleteAsync(ct);
                invoice.Lines.Clear();
                AddManualLines(invoice, lines);
                db.InvoiceLines.AddRange(invoice.Lines);
                await db.SaveChangesAsync(ct);
                return await GetAsync(invoiceId, ct);
            },
            ct);

    /// <summary>Finalises a draft manual invoice.</summary>
    public Task<InvoiceView> FinalizeAsync(Guid invoiceId, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var locked = await db.LockInvoiceWithSubscriptionAsync(invoiceId, ct) ?? throw DomainException.NotFound("Invoice");
                await finalizer.FinalizeAsync(locked.Invoice, ct);
                return await GetAsync(invoiceId, ct);
            },
            ct);

    /// <summary>Voids an open invoice with no payment in progress and returns any applied credit to the customer.</summary>
    public Task<InvoiceView> VoidAsync(Guid invoiceId, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var locked = await db.LockInvoiceWithSubscriptionAsync(invoiceId, ct) ?? throw DomainException.NotFound("Invoice");
                var invoice = locked.Invoice;
                if (invoice.Status != InvoiceStatus.Open)
                {
                    throw DomainException.InvalidState("Only open invoices can be voided.");
                }

                await EnsureNoPaymentInProgressAsync(invoiceId, ct);

                var customer = await db.LockCustomerAsync(invoice.CustomerId, ct)
                    ?? throw new InvalidOperationException($"Customer {invoice.CustomerId} does not exist.");
                invoice.Status = InvoiceStatus.Void;
                invoice.AmountRemainingMinor = 0;
                invoice.NextPaymentAttemptAt = null;
                if (invoice.CreditAppliedMinor > 0)
                {
                    ledger.Post(customer, invoice.CreditAppliedMinor, CreditTransactionKind.VoidReversal, invoiceId: invoice.Id);
                }

                await db.SaveChangesAsync(ct);
                logger.LogInformation("Invoice {InvoiceId} voided", invoice.Id);
                await events.InvoiceAsync(EventTypes.InvoiceVoided, invoice.Id, null, ct);
                return await GetAsync(invoiceId, ct);
            },
            ct);

    public async Task<InvoiceView> GetAsync(Guid invoiceId, CancellationToken ct) =>
        await views.InvoiceAsync(invoiceId, ct) ?? throw DomainException.NotFound("Invoice");

    public async Task<Page<InvoiceView>> ListAsync(Guid? customerId, InvoiceStatus? status, PageRequest page, CancellationToken ct)
    {
        IQueryable<Invoice> source = page.AfterId() is { } after
            ? db.Invoices.FromSql($"SELECT * FROM invoices WHERE id > {after}")
            : db.Invoices;
        if (customerId is { } customer)
        {
            source = source.Where(i => i.CustomerId == customer);
        }

        if (status is { } wanted)
        {
            source = source.Where(i => i.Status == wanted);
        }

        var rows = await source.AsNoTracking()
            .Include(i => i.Lines)
            .OrderBy(i => i.Id)
            .Take(page.Limit + 1)
            .AsSplitQuery()
            .ToListAsync(ct);
        var hasMore = rows.Count > page.Limit;
        var pageRows = rows.Take(page.Limit).ToList();
        var data = await views.InvoicesAsync(pageRows, ct);
        return new Page<InvoiceView>(data, hasMore ? pageRows[^1].Id.ToString() : null);
    }

    /// <summary>Throws when the invoice has a payment attempt that is pending or unknown.</summary>
    public async Task EnsureNoPaymentInProgressAsync(Guid invoiceId, CancellationToken ct)
    {
        var inProgress = await db.PaymentAttempts.AnyAsync(
            a => a.InvoiceId == invoiceId
                && (a.Status == PaymentAttemptStatus.Pending || a.Status == PaymentAttemptStatus.Unknown),
            ct);
        if (inProgress)
        {
            throw DomainException.Conflict(ErrorCodes.PaymentInProgress, "A payment for this invoice is in progress.");
        }
    }

    private void AddManualLines(Invoice invoice, IReadOnlyList<ManualLine> lines)
    {
        foreach (var line in lines)
        {
            invoice.AddLine(clock, InvoiceLineKind.Manual, line.Description, line.Quantity, line.Quantity * line.UnitAmountMinor);
        }
    }
}
