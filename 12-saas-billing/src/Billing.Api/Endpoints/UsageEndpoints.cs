using Billing.Api.Infrastructure;
using Billing.Api.Requests;
using Billing.Api.Validation;
using Billing.Core.Errors;
using Billing.Core.Services;

namespace Billing.Api.Endpoints;

public static class UsageEndpoints
{
    public static void MapUsageEndpoints(this IEndpointRouteBuilder v1)
    {
        v1.MapPost("/usage-events", Ingest).RequireRole(Roles.UsageIngest).Validate<UsageBatchRequest>();
        v1.MapGet("/subscriptions/{id:guid}/usage", Summary).RequireRole(Roles.Everyone);
    }

    private static async Task<IResult> Ingest(UsageBatchRequest body, UsageService usage, CancellationToken ct) =>
        Results.Ok(await usage.IngestAsync(body.Events!.Select(e => e.ToInput()).ToList(), ct));

    private static async Task<IResult> Summary(Guid id, int? periodIndex, UsageService usage, CancellationToken ct)
    {
        if (periodIndex is < 0)
        {
            throw DomainException.Validation("periodIndex", "Must not be negative.");
        }

        return Results.Ok(await usage.SummaryAsync(id, periodIndex, ct));
    }
}
