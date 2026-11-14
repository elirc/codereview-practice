using Billing.Api.Infrastructure;
using Billing.Api.Requests;
using Billing.Api.Validation;
using Billing.Core.Services;

namespace Billing.Api.Endpoints;

public static class CustomerEndpoints
{
    public static void MapCustomerEndpoints(this IEndpointRouteBuilder v1)
    {
        var read = v1.MapGroup("/customers").RequireRole(Roles.Everyone);
        read.MapGet(string.Empty, List);
        read.MapGet("/{id:guid}", Get);

        var write = v1.MapGroup("/customers").RequireRole(Roles.Writers);
        write.MapPost(string.Empty, Create).Validate<CreateCustomerRequest>();
        write.MapPatch("/{id:guid}", Update).Validate<UpdateCustomerRequest>();
        write.MapPut("/{id:guid}/payment-method", SetPaymentMethod).Validate<PaymentMethodRequest>();
    }

    private static async Task<IResult> List(string? after, int? limit, CustomerService customers, CancellationToken ct) =>
        Results.Ok(await customers.ListAsync(PageQuery.Parse(after, limit), ct));

    private static async Task<IResult> Get(Guid id, CustomerService customers, CancellationToken ct) =>
        Results.Ok(await customers.GetAsync(id, ct));

    private static async Task<IResult> Create(CreateCustomerRequest body, CustomerService customers, CancellationToken ct)
    {
        var customer = await customers.CreateAsync(
            new NewCustomer(
                body.ExternalId!,
                body.Name!,
                body.Email!,
                body.Currency!,
                body.Timezone!,
                body.Country!,
                body.Region,
                body.TaxExempt ?? false),
            ct);
        return Results.Created($"/v1/customers/{customer.Id}", customer);
    }

    private static async Task<IResult> Update(Guid id, UpdateCustomerRequest body, CustomerService customers, CancellationToken ct) =>
        Results.Ok(await customers.UpdateAsync(
            id,
            new CustomerChanges(body.Name, body.Email, body.Timezone, body.Country, body.Region, body.TaxExempt),
            ct));

    private static async Task<IResult> SetPaymentMethod(Guid id, PaymentMethodRequest body, CustomerService customers, CancellationToken ct) =>
        Results.Ok(await customers.SetPaymentMethodAsync(id, body.Token!, ct));
}
