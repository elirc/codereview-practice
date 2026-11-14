using Billing.Api.Validation;
using Billing.Core.Data;
using Billing.Domain;

namespace Billing.Api.Requests;

public sealed record CreateCustomerRequest(
    string? ExternalId,
    string? Name,
    string? Email,
    string? Currency,
    string? Timezone,
    string? Country,
    string? Region,
    bool? TaxExempt);

public sealed record UpdateCustomerRequest(
    string? Name,
    string? Email,
    string? Timezone,
    string? Country,
    string? Region,
    bool? TaxExempt);

public sealed record PaymentMethodRequest(string? Token);

public sealed record CreateApiKeyRequest(string? Name, ApiRole? Role);

internal static class CustomerRules
{
    public static void Email(ValidationErrors errors, string? value, bool required) =>
        errors.Matches(value, "email", Patterns.Email(), "Must be an email address.", required);

    public static void Timezone(ValidationErrors errors, string? value, bool required)
    {
        if (value is null)
        {
            if (required)
            {
                errors.Add("timezone", "Is required.");
            }

            return;
        }

        if (!BillingCalendar.TryFindZone(value, out _))
        {
            errors.Add("timezone", "Must be an IANA time zone such as Europe/Berlin.");
        }
    }

    public static void Country(ValidationErrors errors, string? value, bool required) =>
        errors.Matches(value, "country", Patterns.Country(), "Must be an ISO 3166-1 alpha-2 code in upper case.", required);
}

internal sealed class CreateCustomerValidator : IValidator<CreateCustomerRequest>
{
    public void Validate(CreateCustomerRequest value, ValidationErrors errors)
    {
        errors.Text(value.ExternalId, "externalId", 1, 100);
        errors.Text(value.Name, "name", 1, 200);
        CustomerRules.Email(errors, value.Email, required: true);
        if (errors.Required(value.Currency, "currency") && !Currencies.IsSupported(value.Currency))
        {
            errors.Add("currency", "Must be one of USD, EUR or GBP.");
        }

        CustomerRules.Timezone(errors, value.Timezone, required: true);
        CustomerRules.Country(errors, value.Country, required: true);
        errors.Text(value.Region, "region", 1, 50, required: false);
    }
}

internal sealed class UpdateCustomerValidator : IValidator<UpdateCustomerRequest>
{
    public void Validate(UpdateCustomerRequest value, ValidationErrors errors)
    {
        errors.Text(value.Name, "name", 1, 200, required: false);
        CustomerRules.Email(errors, value.Email, required: false);
        CustomerRules.Timezone(errors, value.Timezone, required: false);

        CustomerRules.Country(errors, value.Country, required: false);
        if (value.Region is { Length: > 50 })
        {
            errors.Add("region", "Must be at most 50 characters; an empty string clears it.");
        }

        if (value is { Name: null, Email: null, Timezone: null, Country: null, Region: null, TaxExempt: null })
        {
            errors.Add(string.Empty, "At least one field must be given.");
        }
    }
}

internal sealed class PaymentMethodValidator : IValidator<PaymentMethodRequest>
{
    public void Validate(PaymentMethodRequest value, ValidationErrors errors) =>
        errors.Text(value.Token, "token", 1, 200);
}

internal sealed class CreateApiKeyValidator : IValidator<CreateApiKeyRequest>
{
    public void Validate(CreateApiKeyRequest value, ValidationErrors errors)
    {
        errors.Text(value.Name, "name", 1, 100);
        errors.Required(value.Role, "role");
    }
}
