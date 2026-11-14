namespace Billing.Api.Validation;

/// <summary>Checks one request type and records every invalid field.</summary>
public interface IValidator<in T>
{
    void Validate(T value, ValidationErrors errors);
}
