using Billing.Api.Validation;
using Billing.Core.Data;
using Billing.Core.Services;
using Billing.Core.Webhooks;

namespace Billing.Api.Requests;

public sealed record CreateWebhookEndpointRequest(string? Url, IReadOnlyList<string>? EventTypes);

public sealed record UpdateWebhookEndpointRequest(string? Url, IReadOnlyList<string>? EventTypes, WebhookEndpointStatus? Status);

internal static class WebhookRules
{
    public static void Url(ValidationErrors errors, string? url, bool required) => errors.Text(url, "url", 1, 2000, required);

    public static void EventTypes(ValidationErrors errors, IReadOnlyList<string>? types, bool required)
    {
        if (types is null)
        {
            if (required)
            {
                errors.Add("eventTypes", "Is required.");
            }

            return;
        }

        if (types.Count is 0 or > 20)
        {
            errors.Add("eventTypes", "Between 1 and 20 event types are required.");
            return;
        }

        for (var i = 0; i < types.Count; i++)
        {
            if (types[i] != WebhookEndpointService.AllEvents && !Core.Services.EventTypes.All.Contains(types[i]))
            {
                errors.Add($"eventTypes[{i}]", "Is not a known event type.");
            }
        }
    }
}

internal sealed class CreateWebhookEndpointValidator : IValidator<CreateWebhookEndpointRequest>
{
    public void Validate(CreateWebhookEndpointRequest value, ValidationErrors errors)
    {
        WebhookRules.Url(errors, value.Url, required: true);
        WebhookRules.EventTypes(errors, value.EventTypes, required: true);
    }
}

internal sealed class UpdateWebhookEndpointValidator : IValidator<UpdateWebhookEndpointRequest>
{
    public void Validate(UpdateWebhookEndpointRequest value, ValidationErrors errors)
    {
        WebhookRules.Url(errors, value.Url, required: false);
        WebhookRules.EventTypes(errors, value.EventTypes, required: false);
        if (value is { Url: null, EventTypes: null, Status: null })
        {
            errors.Add(string.Empty, "At least one field must be given.");
        }
    }
}
