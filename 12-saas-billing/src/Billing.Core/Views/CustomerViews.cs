using Billing.Core.Data;

namespace Billing.Core.Views;

public sealed record CustomerView(
    Guid Id,
    string ExternalId,
    string Name,
    string Email,
    string Currency,
    string Timezone,
    string Country,
    string? Region,
    bool TaxExempt,
    bool HasPaymentMethod,
    long CreditBalanceMinor,
    DateTimeOffset CreatedAt)
{
    public static CustomerView From(Customer c) => new(
        c.Id,
        c.ExternalId,
        c.Name,
        c.Email,
        c.Currency,
        c.Timezone,
        c.Country,
        c.Region,
        c.TaxExempt,
        c.PaymentMethodToken is not null,
        c.CreditBalanceMinor,
        c.CreatedAt);
}

public sealed record ApiKeyView(Guid Id, string Name, ApiRole Role, DateTimeOffset CreatedAt, DateTimeOffset? RevokedAt)
{
    public static ApiKeyView From(ApiKey k) => new(k.Id, k.Name, k.Role, k.CreatedAt, k.RevokedAt);
}

public sealed record ApiKeyCreatedView(Guid Id, string Name, ApiRole Role, string Key, DateTimeOffset CreatedAt);
