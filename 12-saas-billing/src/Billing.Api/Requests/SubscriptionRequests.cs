using Billing.Api.Validation;

namespace Billing.Api.Requests;

public sealed record CreateSubscriptionRequest(Guid? CustomerId, string? PlanCode, int? Quantity, int? TrialDays);

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
