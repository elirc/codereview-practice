using Billing.Api.Infrastructure;
using Billing.Api.Requests;
using Billing.Api.Validation;
using Billing.Core.Services;

namespace Billing.Api.Endpoints;

public static class ApiKeyEndpoints
{
    public static void MapApiKeyEndpoints(this IEndpointRouteBuilder v1)
    {
        var admin = v1.MapGroup("/api-keys").RequireRole(Roles.AdminOnly);
        admin.MapPost(string.Empty, Create).Validate<CreateApiKeyRequest>();
        admin.MapDelete("/{id:guid}", Revoke);
    }

    private static async Task<IResult> Create(CreateApiKeyRequest body, ApiKeyService keys, CancellationToken ct)
    {
        var key = await keys.CreateAsync(body.Name!, body.Role!.Value, ct);
        return Results.Created($"/v1/api-keys/{key.Id}", key);
    }

    private static async Task<IResult> Revoke(Guid id, ApiKeyService keys, CancellationToken ct)
    {
        await keys.RevokeAsync(id, ct);
        return Results.NoContent();
    }
}
