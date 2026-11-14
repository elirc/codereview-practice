using Billing.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Billing.Core.Views;

/// <summary>Builds API representations from the current database state.</summary>
public sealed class ViewLoader(BillingDbContext db)
{
    /// <summary>Returns the invoice with its lines, attempts and credit notes, or null when it does not exist.</summary>
    public async Task<InvoiceView?> InvoiceAsync(Guid id, CancellationToken ct)
    {
        var invoice = await db.Invoices.AsNoTracking().Include(i => i.Lines).SingleOrDefaultAsync(i => i.Id == id, ct);
        if (invoice is null)
        {
            return null;
        }

        return (await InvoicesAsync([invoice], ct))[0];
    }

    /// <summary>Returns views of invoices already loaded with their lines, in the given order.</summary>
    public async Task<IReadOnlyList<InvoiceView>> InvoicesAsync(IReadOnlyList<Invoice> invoices, CancellationToken ct)
    {
        var ids = invoices.Select(i => i.Id).ToList();
        var attempts = await db.PaymentAttempts.AsNoTracking().Where(a => ids.Contains(a.InvoiceId)).ToListAsync(ct);
        var notes = await db.CreditNotes.AsNoTracking().Include(n => n.Lines).Where(n => ids.Contains(n.InvoiceId)).ToListAsync(ct);

        var attemptsByInvoice = attempts.ToLookup(a => a.InvoiceId);
        var notesByInvoice = notes.ToLookup(n => n.InvoiceId);
        return invoices.Select(i => InvoiceView.From(i, attemptsByInvoice[i.Id], notesByInvoice[i.Id])).ToList();
    }

    /// <summary>Returns the credit note with its lines, or null when it does not exist.</summary>
    public async Task<CreditNoteView?> CreditNoteAsync(Guid id, CancellationToken ct)
    {
        var note = await db.CreditNotes.AsNoTracking().Include(n => n.Lines).SingleOrDefaultAsync(n => n.Id == id, ct);
        return note is null ? null : CreditNoteView.From(note);
    }
}
