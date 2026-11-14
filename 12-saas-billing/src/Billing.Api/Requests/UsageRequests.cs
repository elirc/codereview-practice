using Billing.Api.Validation;
using Billing.Core.Services;

namespace Billing.Api.Requests;

public sealed record UsageEventRequest(string? EventKey, Guid? SubscriptionId, string? MeterCode, long? Quantity, DateTimeOffset? OccurredAt)
{
    public UsageEventInput ToInput() => new(EventKey!, SubscriptionId!.Value, MeterCode!, Quantity!.Value, OccurredAt!.Value);
}

public sealed record UsageBatchRequest(IReadOnlyList<UsageEventRequest>? Events);

internal sealed class UsageBatchValidator : IValidator<UsageBatchRequest>
{
    public const int MaxEvents = 500;
    public const long MaxQuantity = 1_000_000_000_000;

    public void Validate(UsageBatchRequest value, ValidationErrors errors)
    {
        if (value.Events is null || value.Events.Count is 0 or > MaxEvents)
        {
            errors.Add("events", $"Between 1 and {MaxEvents} events are required.");
            return;
        }

        for (var i = 0; i < value.Events.Count; i++)
        {
            var e = value.Events[i];
            var path = $"events[{i}]";
            errors.Text(e.EventKey, $"{path}.eventKey", 1, 100);
            errors.Required(e.SubscriptionId, $"{path}.subscriptionId");
            errors.Matches(e.MeterCode, $"{path}.meterCode", Patterns.Code(), "Must be a meter code.");
            errors.Range(e.Quantity, $"{path}.quantity", 1, MaxQuantity);
            errors.Required(e.OccurredAt, $"{path}.occurredAt");
        }
    }
}
