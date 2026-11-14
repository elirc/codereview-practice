using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Billing.Core.Data;

/// <summary>Transaction, row-lock and error helpers on top of <see cref="BillingDbContext"/>.</summary>
public static class DbContextExtensions
{
    /// <summary>Runs <paramref name="work"/> in the current transaction, or in a new one that is committed when it returns.</summary>
    public static async Task<T> InTransactionAsync<T>(this BillingDbContext db, Func<Task<T>> work, CancellationToken ct)
    {
        if (db.Database.CurrentTransaction is not null)
        {
            return await work();
        }

        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var result = await work();
        await transaction.CommitAsync(ct);
        return result;
    }

    /// <summary>Runs <paramref name="work"/> in the current transaction, or in a new one that is committed when it returns.</summary>
    public static Task InTransactionAsync(this BillingDbContext db, Func<Task> work, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                await work();
                return true;
            },
            ct);

    /// <summary>Loads a subscription with <c>FOR UPDATE</c>; returns null when it does not exist.</summary>
    public static Task<Subscription?> LockSubscriptionAsync(this BillingDbContext db, Guid id, CancellationToken ct) =>
        LockAsync(db, db.Subscriptions.FromSql($"SELECT * FROM subscriptions WHERE id = {id} FOR UPDATE"), s => s.Id == id, ct);

    /// <summary>Loads an invoice with <c>FOR UPDATE</c>; returns null when it does not exist.</summary>
    public static Task<Invoice?> LockInvoiceAsync(this BillingDbContext db, Guid id, CancellationToken ct) =>
        LockAsync(db, db.Invoices.FromSql($"SELECT * FROM invoices WHERE id = {id} FOR UPDATE"), i => i.Id == id, ct);

    /// <summary>Loads a customer with <c>FOR UPDATE</c>; returns null when it does not exist.</summary>
    public static Task<Customer?> LockCustomerAsync(this BillingDbContext db, Guid id, CancellationToken ct) =>
        LockAsync(db, db.Customers.FromSql($"SELECT * FROM customers WHERE id = {id} FOR UPDATE"), c => c.Id == id, ct);

    /// <summary>Loads a credit note with <c>FOR UPDATE</c>; returns null when it does not exist.</summary>
    public static Task<CreditNote?> LockCreditNoteAsync(this BillingDbContext db, Guid id, CancellationToken ct) =>
        LockAsync(db, db.CreditNotes.FromSql($"SELECT * FROM credit_notes WHERE id = {id} FOR UPDATE"), n => n.Id == id, ct);

    /// <summary>
    /// Locks an invoice together with its subscription, subscription first; returns null when the invoice does not exist.
    /// </summary>
    public static async Task<(Invoice Invoice, Subscription? Subscription)?> LockInvoiceWithSubscriptionAsync(
        this BillingDbContext db,
        Guid invoiceId,
        CancellationToken ct)
    {
        var subscriptionId = await db.Invoices.AsNoTracking()
            .Where(i => i.Id == invoiceId)
            .Select(i => new { i.SubscriptionId })
            .SingleOrDefaultAsync(ct);
        if (subscriptionId is null)
        {
            return null;
        }

        Subscription? subscription = null;
        if (subscriptionId.SubscriptionId is { } id)
        {
            subscription = await db.LockSubscriptionAsync(id, ct);
        }

        var invoice = await db.LockInvoiceAsync(invoiceId, ct);
        return invoice is null ? null : (invoice, subscription);
    }

    /// <summary>Returns whether the exception is a unique violation, optionally of the named constraint.</summary>
    public static bool IsUniqueViolation(this DbUpdateException exception, string? constraint = null) =>
        exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } postgres
        && (constraint is null || postgres.ConstraintName == constraint);

    /// <summary>Returns whether the exception is an exclusion-constraint violation.</summary>
    public static bool IsExclusionViolation(this DbUpdateException exception) =>
        exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.ExclusionViolation };

    private static async Task<T?> LockAsync<T>(BillingDbContext db, IQueryable<T> query, Func<T, bool> matches, CancellationToken ct)
        where T : class
    {
        var wasTracked = db.ChangeTracker.Entries<T>().Any(e => matches(e.Entity));
        var row = (await query.ToListAsync(ct)).SingleOrDefault();
        if (row is not null && wasTracked)
        {
            await db.Entry(row).ReloadAsync(ct);
        }

        return row;
    }
}
