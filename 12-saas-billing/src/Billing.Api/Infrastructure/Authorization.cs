using Billing.Core;
using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Services;

namespace Billing.Api.Infrastructure;

/// <summary>The authenticated API key behind a request.</summary>
public sealed record Caller(Guid KeyId, ApiRole Role);

/// <summary>The role sets of the permission matrix.</summary>
public static class Roles
{
    public static readonly ApiRole[] Everyone = [ApiRole.Service, ApiRole.Support, ApiRole.BillingOps, ApiRole.Admin];
    public static readonly ApiRole[] Writers = [ApiRole.Service, ApiRole.BillingOps, ApiRole.Admin];
    public static readonly ApiRole[] UsageIngest = [ApiRole.Service];
    public static readonly ApiRole[] Ops = [ApiRole.BillingOps, ApiRole.Admin];
    public static readonly ApiRole[] AdminOnly = [ApiRole.Admin];
}

/// <summary>Resolves the bearer API key of every <c>/v1</c> request into a <see cref="Caller"/>.</summary>
public sealed class ApiKeyMiddleware(RequestDelegate next)
{
    private const string Scheme = "Bearer ";

    public async Task InvokeAsync(HttpContext context, ApiKeyService keys, RequestContext requestContext)
    {
        if (!context.Request.Path.StartsWithSegments("/v1"))
        {
            await next(context);
            return;
        }

        var header = context.Request.Headers.Authorization.ToString();
        if (!header.StartsWith(Scheme, StringComparison.Ordinal) || header.Length <= Scheme.Length)
        {
            throw DomainException.Unauthenticated();
        }

        var key = await keys.FindActiveAsync(header[Scheme.Length..].Trim(), context.RequestAborted)
            ?? throw DomainException.Unauthenticated();

        context.Features.Set(new Caller(key.Id, key.Role));
        requestContext.ApiKeyId = key.Id;
        await next(context);
    }
}

/// <summary>Rejects callers whose role is not in the allowed set.</summary>
public sealed class RoleFilter(IReadOnlySet<ApiRole> allowed) : IEndpointFilter
{
    public ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var caller = context.HttpContext.GetCaller();
        if (!allowed.Contains(caller.Role))
        {
            throw DomainException.Forbidden();
        }

        return next(context);
    }
}

public static class AuthorizationExtensions
{
    /// <summary>Returns the authenticated caller; throws when the request has none.</summary>
    public static Caller GetCaller(this HttpContext context) =>
        context.Features.Get<Caller>() ?? throw DomainException.Unauthenticated();

    /// <summary>Allows only the given roles through the endpoints built from this builder.</summary>
    public static TBuilder RequireRole<TBuilder>(this TBuilder builder, params ApiRole[] roles)
        where TBuilder : IEndpointConventionBuilder =>
        builder.AddEndpointFilter(new RoleFilter(roles.ToHashSet()));
}
