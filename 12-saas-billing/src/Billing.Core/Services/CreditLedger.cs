using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Billing.Core.Services;

/// <summary>Posts changes to a customer's credit balance together with their ledger transaction.</summary>
public sealed class CreditLedger(BillingDbContext db, TimeProvider clock)
{
    /// <summary>
    /// Adds the signed amount to the balance of a customer the caller has locked and records the transaction;
    /// throws when the balance would become negative.
    /// </summary>
    public CreditBalanceTransaction Post(
        Customer customer,
        long amountMinor,
        CreditTransactionKind kind,
        Guid? invoiceId = null,
        Guid? creditNoteId = null,
        string? description = null)
    {
        var balance = customer.CreditBalanceMinor + amountMinor;
        if (balance < 0)
        {
            throw DomainException.Unprocessable(ErrorCodes.InsufficientCredit, "The customer's credit balance cannot go below zero.");
        }

        customer.CreditBalanceMinor = balance;
        var transaction = new CreditBalanceTransaction
        {
            Id = Ids.New(clock),
            CustomerId = customer.Id,
            AmountMinor = amountMinor,
            Kind = kind,
            InvoiceId = invoiceId,
            CreditNoteId = creditNoteId,
            Description = description,
            BalanceAfterMinor = balance,
            CreatedAt = clock.GetUtcNow(),
        };
        db.CreditBalanceTransactions.Add(transaction);
        return transaction;
    }
}

/// <summary>Hands out gapless yearly document numbers.</summary>
public sealed class DocumentNumberer(BillingDbContext db)
{
    /// <summary>Takes the next number of the counter for the year and returns it formatted.</summary>
    public async Task<string> NextAsync(CounterName counter, int year, CancellationToken ct)
    {
        var name = Naming.EnumValue(counter);
        await db.Database.ExecuteSqlAsync(
            $"INSERT INTO counters (name, year, next) VALUES ({name}, {year}, 1) ON CONFLICT (name, year) DO NOTHING",
            ct);
        var taken = (await db.Database
            .SqlQuery<long>($"UPDATE counters SET next = next + 1 WHERE name = {name} AND year = {year} RETURNING next - 1 AS \"Value\"")
            .ToListAsync(ct))
            .Single();

        var prefix = counter == CounterName.Invoice ? DocumentNumbers.InvoicePrefix : DocumentNumbers.CreditNotePrefix;
        return DocumentNumbers.Format(prefix, year, taken);
    }
}
