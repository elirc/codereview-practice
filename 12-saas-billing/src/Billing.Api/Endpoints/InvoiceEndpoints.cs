using Billing.Api.Infrastructure;
using Billing.Api.Requests;
using Billing.Api.Validation;
using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Services;

namespace Billing.Api.Endpoints;

public static class InvoiceEndpoints
{
    public static void MapInvoiceEndpoints(this IEndpointRouteBuilder v1)
    {
        var read = v1.MapGroup("/invoices").RequireRole(Roles.Everyone);
        read.MapGet(string.Empty, List);
        read.MapGet("/{id:guid}", Get);

        var ops = v1.MapGroup("/invoices").RequireRole(Roles.Ops);
        ops.MapPost(string.Empty, Create).Validate<CreateInvoiceRequest>();
        ops.MapPut("/{id:guid}/lines", ReplaceLines).Validate<ReplaceInvoiceLinesRequest>();
        ops.MapPost("/{id:guid}/finalize", FinalizeInvoice);
        ops.MapPost("/{id:guid}/void", VoidInvoice);
        ops.MapPost("/{id:guid}/pay", RetryPayment);
    }

    private static async Task<IResult> List(
        Guid? customerId,
        string? status,
        string? after,
        int? limit,
        InvoiceService invoices,
        CancellationToken ct)
    {
        InvoiceStatus? parsed = null;
        if (status is not null)
        {
            parsed = Naming.TryParseEnum<InvoiceStatus>(status, out var value)
                ? value
                : throw DomainException.Validation("status", "Must be draft, open, paid, void or uncollectible.");
        }

        return Results.Ok(await invoices.ListAsync(customerId, parsed, PageQuery.Parse(after, limit), ct));
    }

    private static async Task<IResult> Get(Guid id, InvoiceService invoices, CancellationToken ct) =>
        Results.Ok(await invoices.GetAsync(id, ct));

    private static async Task<IResult> Create(CreateInvoiceRequest body, InvoiceService invoices, CancellationToken ct)
    {
        var invoice = await invoices.CreateDraftAsync(body.CustomerId!.Value, body.Lines!.Select(l => l.ToLine()).ToList(), ct);
        return Results.Created($"/v1/invoices/{invoice.Id}", invoice);
    }

    private static async Task<IResult> ReplaceLines(Guid id, ReplaceInvoiceLinesRequest body, InvoiceService invoices, CancellationToken ct) =>
        Results.Ok(await invoices.ReplaceLinesAsync(id, body.Lines!.Select(l => l.ToLine()).ToList(), ct));

    private static async Task<IResult> FinalizeInvoice(Guid id, InvoiceService invoices, CancellationToken ct) =>
        Results.Ok(await invoices.FinalizeAsync(id, ct));

    private static async Task<IResult> VoidInvoice(Guid id, InvoiceService invoices, CancellationToken ct) =>
        Results.Ok(await invoices.VoidAsync(id, ct));

    private static async Task<IResult> RetryPayment(Guid id, PaymentService payments, CancellationToken ct) =>
        Results.Ok(await payments.RetryNowAsync(id, ct));
}
