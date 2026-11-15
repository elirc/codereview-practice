using Billing.Api.Infrastructure;
using Billing.Api.Requests;
using Billing.Api.Validation;
using Billing.Core.Errors;
using Billing.Core.Services;

namespace Billing.Api.Endpoints;

public static class SubscriptionEndpoints
{
    public static void MapSubscriptionEndpoints(this IEndpointRouteBuilder v1)
    {
        var read = v1.MapGroup("/subscriptions").RequireRole(Roles.Everyone);
        read.MapGet(string.Empty, List);
        read.MapGet("/{id:guid}", Get);
        read.MapGet("/{id:guid}/change-preview", PreviewChange);

        var write = v1.MapGroup("/subscriptions").RequireRole(Roles.Writers);
        write.MapPost(string.Empty, Create).Validate<CreateSubscriptionRequest>();
        write.MapPost("/{id:guid}/change", Change).Validate<ChangeSubscriptionRequest>();
        write.MapPost("/{id:guid}/cancel", Cancel).Validate<CancelSubscriptionRequest>();
        write.MapPost("/{id:guid}/resume", Resume);
    }

    private static Task<IResult> Change(
        Guid id,
        ChangeSubscriptionRequest body,
        HttpContext http,
        IdempotentExecutor idempotency,
        SubscriptionLifecycle lifecycle,
        CancellationToken ct) =>
        idempotency.ExecuteAsync(
            http,
            body,
            StatusCodes.Status200OK,
            () => lifecycle.ChangeAsync(id, body.PlanCode, body.Quantity, ct),
            ct);

    private static async Task<IResult> PreviewChange(
        Guid id,
        string? planCode,
        int? quantity,
        SubscriptionLifecycle lifecycle,
        CancellationToken ct)
    {
        var errors = new ValidationErrors();
        new ChangeSubscriptionValidator().Validate(new ChangeSubscriptionRequest(planCode, quantity), errors);
        if (errors.HasErrors)
        {
            throw DomainException.Validation(errors.Fields);
        }

        return Results.Ok(await lifecycle.PreviewChangeAsync(id, planCode, quantity, ct));
    }

    private static Task<IResult> Cancel(
        Guid id,
        CancelSubscriptionRequest body,
        HttpContext http,
        IdempotentExecutor idempotency,
        SubscriptionLifecycle lifecycle,
        CancellationToken ct) =>
        idempotency.ExecuteAsync(
            http,
            body,
            StatusCodes.Status200OK,
            () => lifecycle.CancelAsync(id, body.Mode!.Value, ct),
            ct);

    private static async Task<IResult> Resume(Guid id, SubscriptionLifecycle lifecycle, CancellationToken ct) =>
        Results.Ok(await lifecycle.ResumeAsync(id, ct));

    private static async Task<IResult> List(Guid? customerId, string? after, int? limit, SubscriptionService subscriptions, CancellationToken ct) =>
        Results.Ok(await subscriptions.ListAsync(customerId, PageQuery.Parse(after, limit), ct));

    private static async Task<IResult> Get(Guid id, SubscriptionService subscriptions, CancellationToken ct) =>
        Results.Ok(await subscriptions.GetAsync(id, ct));

    private static Task<IResult> Create(
        CreateSubscriptionRequest body,
        HttpContext http,
        IdempotentExecutor idempotency,
        SubscriptionService subscriptions,
        CancellationToken ct) =>
        idempotency.ExecuteAsync(
            http,
            body,
            StatusCodes.Status201Created,
            () => subscriptions.CreateAsync(
                new NewSubscription(body.CustomerId!.Value, body.PlanCode!, body.Quantity ?? 1, body.TrialDays),
                ct),
            ct);
}
