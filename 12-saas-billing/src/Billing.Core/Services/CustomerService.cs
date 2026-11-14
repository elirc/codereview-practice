using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Views;
using Microsoft.EntityFrameworkCore;

namespace Billing.Core.Services;

public sealed record NewCustomer(
    string ExternalId,
    string Name,
    string Email,
    string Currency,
    string Timezone,
    string Country,
    string? Region,
    bool TaxExempt);

/// <summary>Fields to change on a customer; null leaves a field unchanged and an empty region clears it.</summary>
public sealed record CustomerChanges(
    string? Name,
    string? Email,
    string? Timezone,
    string? Country,
    string? Region,
    bool? TaxExempt);

/// <summary>Creates, reads and updates customers.</summary>
public sealed class CustomerService(BillingDbContext db, TimeProvider clock)
{
    public async Task<CustomerView> CreateAsync(NewCustomer input, CancellationToken ct)
    {
        var customer = new Customer
        {
            Id = Ids.New(clock),
            ExternalId = input.ExternalId,
            Name = input.Name,
            Email = input.Email,
            Currency = input.Currency,
            Timezone = input.Timezone,
            Country = input.Country,
            Region = input.Region,
            TaxExempt = input.TaxExempt,
            CreatedAt = clock.GetUtcNow(),
        };
        db.Customers.Add(customer);

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.IsUniqueViolation("ux_customers_external_id"))
        {
            throw DomainException.Conflict(ErrorCodes.AlreadyExists, "A customer with this externalId already exists.");
        }

        return CustomerView.From(customer);
    }

    public async Task<CustomerView> GetAsync(Guid id, CancellationToken ct)
    {
        var customer = await db.Customers.AsNoTracking().SingleOrDefaultAsync(c => c.Id == id, ct)
            ?? throw DomainException.NotFound("Customer");
        return CustomerView.From(customer);
    }

    public async Task<Page<CustomerView>> ListAsync(PageRequest page, CancellationToken ct)
    {
        IQueryable<Customer> source = page.AfterId() is { } after
            ? db.Customers.FromSql($"SELECT * FROM customers WHERE id > {after}")
            : db.Customers;
        var rows = await source.AsNoTracking().OrderBy(c => c.Id).Take(page.Limit + 1).ToListAsync(ct);
        return Paging.Build(rows, page.Limit, c => c.Id.ToString(), CustomerView.From);
    }

    /// <summary>Applies the changes; the time zone cannot change while the customer has a live subscription.</summary>
    public Task<CustomerView> UpdateAsync(Guid id, CustomerChanges changes, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var customer = await db.LockCustomerAsync(id, ct) ?? throw DomainException.NotFound("Customer");

                if (changes.Timezone is not null && changes.Timezone != customer.Timezone)
                {
                    var hasLiveSubscription = await db.Subscriptions
                        .AnyAsync(s => s.CustomerId == id && s.Status != SubscriptionStatus.Canceled, ct);
                    if (hasLiveSubscription)
                    {
                        throw DomainException.InvalidState("The time zone cannot change while the customer has a live subscription.");
                    }

                    customer.Timezone = changes.Timezone;
                }

                customer.Name = changes.Name ?? customer.Name;
                customer.Email = changes.Email ?? customer.Email;
                customer.Country = changes.Country ?? customer.Country;
                customer.TaxExempt = changes.TaxExempt ?? customer.TaxExempt;
                if (changes.Region is not null)
                {
                    customer.Region = changes.Region.Length == 0 ? null : changes.Region;
                }

                await db.SaveChangesAsync(ct);
                return CustomerView.From(customer);
            },
            ct);

    /// <summary>Stores the gateway token used to charge the customer.</summary>
    public Task<CustomerView> SetPaymentMethodAsync(Guid id, string token, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var customer = await db.LockCustomerAsync(id, ct) ?? throw DomainException.NotFound("Customer");
                customer.PaymentMethodToken = token;
                await db.SaveChangesAsync(ct);
                return CustomerView.From(customer);
            },
            ct);
}
