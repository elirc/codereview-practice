using Billing.Api.Infrastructure;
using Billing.Api.Requests;
using Billing.Api.Validation;
using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Webhooks;

namespace Billing.Api.Endpoints;

public static class WebhookEndpoints
{
    public static void MapWebhookEndpoints(this IEndpointRouteBuilder v1)
    {
        var read = v1.MapGroup(string.Empty).RequireRole(Roles.Ops);
        read.MapGet("/webhook-endpoints", ListEndpoints);
        read.MapGet("/webhook-endpoints/{id:guid}", GetEndpoint);
        read.MapGet("/webhook-deliveries", ListDeliveries);
        read.MapPost("/webhook-deliveries/{id:guid}/retry", RetryDelivery);

        var admin = v1.MapGroup("/webhook-endpoints").RequireRole(Roles.AdminOnly);
        admin.MapPost(string.Empty, Create).Validate<CreateWebhookEndpointRequest>();
        admin.MapPatch("/{id:guid}", Update).Validate<UpdateWebhookEndpointRequest>();
        admin.MapPost("/{id:guid}/rotate-secret", RotateSecret);
    }

    private static async Task<IResult> ListEndpoints(string? after, int? limit, WebhookEndpointService endpoints, CancellationToken ct) =>
        Results.Ok(await endpoints.ListAsync(PageQuery.Parse(after, limit), ct));

    private static async Task<IResult> GetEndpoint(Guid id, WebhookEndpointService endpoints, CancellationToken ct) =>
        Results.Ok(await endpoints.GetAsync(id, ct));

    private static async Task<IResult> Create(CreateWebhookEndpointRequest body, WebhookEndpointService endpoints, CancellationToken ct)
    {
        var endpoint = await endpoints.CreateAsync(body.Url!, body.EventTypes!, ct);
        return Results.Created($"/v1/webhook-endpoints/{endpoint.Id}", endpoint);
    }

    private static async Task<IResult> Update(Guid id, UpdateWebhookEndpointRequest body, WebhookEndpointService endpoints, CancellationToken ct) =>
        Results.Ok(await endpoints.UpdateAsync(id, new WebhookEndpointChanges(body.Url, body.EventTypes, body.Status), ct));

    private static async Task<IResult> RotateSecret(Guid id, WebhookEndpointService endpoints, CancellationToken ct) =>
        Results.Ok(await endpoints.RotateSecretAsync(id, ct));

    private static async Task<IResult> ListDeliveries(
        Guid? endpointId,
        string? status,
        string? after,
        int? limit,
        WebhookDeliveryService deliveries,
        CancellationToken ct)
    {
        WebhookDeliveryStatus? parsed = null;
        if (status is not null)
        {
            parsed = Naming.TryParseEnum<WebhookDeliveryStatus>(status, out var value)
                ? value
                : throw DomainException.Validation("status", "Must be pending, succeeded or failed.");
        }

        return Results.Ok(await deliveries.ListAsync(endpointId, parsed, PageQuery.Parse(after, limit), ct));
    }

    private static async Task<IResult> RetryDelivery(Guid id, WebhookDeliveryService deliveries, CancellationToken ct) =>
        Results.Ok(await deliveries.RetryAsync(id, ct));
}
