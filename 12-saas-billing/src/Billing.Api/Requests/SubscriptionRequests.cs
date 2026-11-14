using Billing.Api.Validation;
using Billing.Core.Services;

namespace Billing.Api.Requests;

public sealed record CreateSubscriptionRequest(Guid? CustomerId, string? PlanCode, int? Quantity, int? TrialDays);

public sealed record ChangeSubscriptionRequest(string? PlanCode, int? Quantity);

public sealed record CancelSubscriptionRequest(CancelMode? Mode);

internal sealed class ChangeSubscriptionValidator : IValidator<ChangeSubscriptionRequest>
{
    public void Validate(ChangeSubscriptionRequest value, ValidationErrors errors)
    {
        errors.Text(value.PlanCode, "planCode", 1, 64, required: false);
        errors.Range(value.Quantity, "quantity", 1, CreateSubscriptionValidator.MaxQuantity, required: false);
        if (value.PlanCode is null && value.Quantity is null)
        {
            errors.Add(string.Empty, "planCode or quantity is required.");
        }
    }
}

internal sealed class CancelSubscriptionValidator : IValidator<CancelSubscriptionRequest>
{
    public void Validate(CancelSubscriptionRequest value, ValidationErrors errors) => errors.Required(value.Mode, "mode");
}

internal sealed class CreateSubscriptionValidator : IValidator<CreateSubscriptionRequest>
{
    public const int MaxQuantity = 100_000;

    public void Validate(CreateSubscriptionRequest value, ValidationErrors errors)
    {
        errors.Required(value.CustomerId, "customerId");
        errors.Text(value.PlanCode, "planCode", 1, 64);
        errors.Range(value.Quantity, "quantity", 1, MaxQuantity, required: false);
        errors.Range(value.TrialDays, "trialDays", 0, 90, required: false);
    }
}
