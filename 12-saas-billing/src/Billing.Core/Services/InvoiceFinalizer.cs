using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Services;

/// <summary>Turns draft invoices into open or paid ones.</summary>
public sealed class InvoiceFinalizer(
    BillingDbContext db,
    TimeProvider clock,
    CreditLedger ledger,
    DocumentNumberer numbers,
    EventRecorder events,
    ILogger<InvoiceFinalizer> logger)
{
    /// <summary>
    /// Finalises a saved draft invoice: snapshots the customer, taxes every line, applies the
    /// customer's credit, assigns the next invoice number and leaves the invoice open or paid.
    /// </summary>
    public async Task FinalizeAsync(Invoice invoice, CancellationToken ct)
    {
        if (invoice.Status != InvoiceStatus.Draft)
        {
            throw DomainException.InvalidState("Only draft invoices can be finalised.");
        }

        var linesEntry = db.Entry(invoice).Collection(i => i.Lines);
        if (!linesEntry.IsLoaded)
        {
            await linesEntry.LoadAsync(ct);
        }

        var customer = await db.LockCustomerAsync(invoice.CustomerId, ct)
            ?? throw new InvalidOperationException($"Customer {invoice.CustomerId} does not exist.");
        var now = clock.GetUtcNow();
        var issueDate = BillingCalendar.Today(now, BillingCalendar.FindZone(customer.Timezone));

        if (invoice.Lines.Count == 0)
        {
            throw DomainException.Unprocessable(ErrorCodes.InvoiceNotFinalizable, "An invoice without lines cannot be finalised.");
        }

        var rateBps = await TaxRateAsync(customer, issueDate, ct);
        foreach (var line in invoice.Lines)
        {
            line.TaxRateBps = rateBps;
            line.TaxMinor = TaxMath.LineTax(line.AmountMinor, rateBps);
        }

        var subtotal = invoice.Lines.Sum(l => l.AmountMinor);
        var tax = invoice.Lines.Sum(l => l.TaxMinor);
        var total = subtotal + tax;
        if (total < 0)
        {
            throw DomainException.Unprocessable(ErrorCodes.InvoiceNotFinalizable, "An invoice with a negative total cannot be finalised.");
        }

        await db.SaveChangesAsync(ct);

        invoice.BillToName = customer.Name;
        invoice.BillToEmail = customer.Email;
        invoice.BillToCountry = customer.Country;
        invoice.BillToRegion = customer.Region;
        invoice.BillToTaxExempt = customer.TaxExempt;
        invoice.IssueDate = issueDate;
        invoice.SubtotalMinor = subtotal;
        invoice.TaxMinor = tax;
        invoice.TotalMinor = total;

        var credit = Math.Min(customer.CreditBalanceMinor, total);
        if (credit > 0)
        {
            ledger.Post(customer, -credit, CreditTransactionKind.AppliedToInvoice, invoiceId: invoice.Id);
        }

        invoice.CreditAppliedMinor = credit;
        invoice.AmountDueMinor = total - credit;
        invoice.AmountRemainingMinor = total - credit;
        invoice.Number = await numbers.NextAsync(CounterName.Invoice, issueDate.Year, ct);
        invoice.FinalizedAt = now;

        if (invoice.AmountRemainingMinor == 0)
        {
            invoice.Status = InvoiceStatus.Paid;
            invoice.PaidAt = now;
            invoice.NextPaymentAttemptAt = null;
        }
        else
        {
            invoice.Status = InvoiceStatus.Open;
            invoice.NextPaymentAttemptAt = now;
        }

        await db.SaveChangesAsync(ct);
        logger.LogInformation(
            "Invoice {InvoiceId} finalized as {Number} with total {TotalMinor} {Currency}",
            invoice.Id,
            invoice.Number,
            invoice.TotalMinor,
            invoice.Currency);

        await events.InvoiceAsync(EventTypes.InvoiceFinalized, invoice.Id, null, ct);
        if (invoice.Status == InvoiceStatus.Paid)
        {
            await events.InvoiceAsync(EventTypes.InvoicePaid, invoice.Id, null, ct);
        }
    }

    private async Task<int> TaxRateAsync(Customer customer, DateOnly issueDate, CancellationToken ct)
    {
        if (customer.TaxExempt)
        {
            return 0;
        }

        var rates = await db.TaxRates.AsNoTracking()
            .Where(r => r.Country == customer.Country)
            .Select(r => new TaxRateCandidate(r.Country, r.Region, r.RateBps, r.ValidFrom, r.ValidTo))
            .ToListAsync(ct);
        return TaxMath.SelectRate(rates, customer.Country, customer.Region, issueDate, customer.TaxExempt);
    }
}
