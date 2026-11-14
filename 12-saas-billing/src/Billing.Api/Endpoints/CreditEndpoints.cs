using Billing.Api.Infrastructure;
using Billing.Api.Requests;
using Billing.Api.Validation;
using Billing.Core.Services;

namespace Billing.Api.Endpoints;

public static class CreditEndpoints
{
    public static void MapCreditEndpoints(this IEndpointRouteBuilder v1)
    {
        var read = v1.MapGroup(string.Empty).RequireRole(Roles.Everyone);
        read.MapGet("/credit-notes/{id:guid}", Get);
        read.MapGet("/customers/{id:guid}/credit-transactions", ListTransactions);

        var ops = v1.MapGroup(string.Empty).RequireRole(Roles.Ops);
        ops.MapPost("/invoices/{id:guid}/credit-notes", Create).Validate<CreateCreditNoteRequest>();
        ops.MapPost("/customers/{id:guid}/credit-adjustments", Adjust).Validate<CreditAdjustmentRequest>();
    }

    private static async Task<IResult> Get(Guid id, CreditNoteService creditNotes, CancellationToken ct) =>
        Results.Ok(await creditNotes.GetAsync(id, ct));

    private static async Task<IResult> ListTransactions(Guid id, string? after, int? limit, CreditNoteService creditNotes, CancellationToken ct) =>
        Results.Ok(await creditNotes.ListCreditTransactionsAsync(id, PageQuery.Parse(after, limit), ct));

    private static Task<IResult> Create(
        Guid id,
        CreateCreditNoteRequest body,
        HttpContext http,
        IdempotentExecutor idempotency,
        CreditNoteService creditNotes,
        CancellationToken ct)
    {
        var input = new NewCreditNote(
            body.Lines!.Select(l => new CreditNoteLineInput(l.InvoiceLineId!.Value, l.AmountMinor!.Value)).ToList(),
            body.Reason!,
            body.Disposition!.Value);
        var caller = http.GetCaller();
        return idempotency.ExecuteAsync(
            http,
            body,
            StatusCodes.Status201Created,
            () => creditNotes.CreateAsync(id, input, caller.KeyId, ct),
            ct);
    }

    private static Task<IResult> Adjust(
        Guid id,
        CreditAdjustmentRequest body,
        HttpContext http,
        IdempotentExecutor idempotency,
        CreditNoteService creditNotes,
        CancellationToken ct) =>
        idempotency.ExecuteAsync(
            http,
            body,
            StatusCodes.Status201Created,
            () => creditNotes.AdjustCreditAsync(id, body.AmountMinor!.Value, body.Reason!, ct),
            ct);
}
