using Billing.Api.Infrastructure;
using Billing.Api.Requests;
using Billing.Api.Validation;
using Billing.Core.Services;
using Billing.Domain;

namespace Billing.Api.Endpoints;

public static class CatalogEndpoints
{
    public static void MapCatalogEndpoints(this IEndpointRouteBuilder v1)
    {
        var read = v1.MapGroup(string.Empty).RequireRole(Roles.Everyone);
        read.MapGet("/products", ListProducts);
        read.MapGet("/plans", ListPlans);
        read.MapGet("/plans/{code}", GetPlan);
        read.MapGet("/meters", ListMeters);
        read.MapGet("/tax-rates", ListTaxRates);

        var admin = v1.MapGroup(string.Empty).RequireRole(Roles.AdminOnly);
        admin.MapPost("/products", CreateProduct).Validate<CreateProductRequest>();
        admin.MapPost("/plans", CreatePlan).Validate<CreatePlanRequest>();
        admin.MapPost("/plans/{code}/retire", RetirePlan);
        admin.MapPost("/meters", CreateMeter).Validate<CreateMeterRequest>();
        admin.MapPost("/tax-rates", CreateTaxRate).Validate<CreateTaxRateRequest>();
    }

    private static async Task<IResult> ListProducts(string? after, int? limit, CatalogService catalog, CancellationToken ct) =>
        Results.Ok(await catalog.ListProductsAsync(PageQuery.Parse(after, limit), ct));

    private static async Task<IResult> CreateProduct(CreateProductRequest body, CatalogService catalog, CancellationToken ct)
    {
        var product = await catalog.CreateProductAsync(body.Name!, ct);
        return Results.Created($"/v1/products/{product.Id}", product);
    }

    private static async Task<IResult> ListPlans(Guid? productId, string? after, int? limit, CatalogService catalog, CancellationToken ct) =>
        Results.Ok(await catalog.ListPlansAsync(productId, PageQuery.Parse(after, limit), ct));

    private static async Task<IResult> GetPlan(string code, CatalogService catalog, CancellationToken ct) =>
        Results.Ok(await catalog.GetPlanAsync(code, ct));

    private static async Task<IResult> CreatePlan(CreatePlanRequest body, CatalogService catalog, CancellationToken ct)
    {
        var items = body.Items!
            .Select(i => new NewPlanItem(
                i.Kind!.Value,
                i.Name!,
                i.UnitAmountMinor,
                i.MeterCode,
                i.TierMode,
                (i.Tiers ?? []).Select(t => new PriceTierSpec(t.UpTo, t.UnitAmountMinor!.Value, t.FlatAmountMinor!.Value)).ToList()))
            .ToList();

        var plan = await catalog.CreatePlanAsync(
            new NewPlan(body.ProductId!.Value, body.Code!, body.Name!, body.Interval!.Value, body.Currency!, body.TrialDays ?? 0, items),
            ct);
        return Results.Created($"/v1/plans/{plan.Code}", plan);
    }

    private static async Task<IResult> RetirePlan(string code, CatalogService catalog, CancellationToken ct) =>
        Results.Ok(await catalog.RetirePlanAsync(code, ct));

    private static async Task<IResult> ListMeters(string? after, int? limit, CatalogService catalog, CancellationToken ct) =>
        Results.Ok(await catalog.ListMetersAsync(PageQuery.Parse(after, limit), ct));

    private static async Task<IResult> CreateMeter(CreateMeterRequest body, CatalogService catalog, CancellationToken ct)
    {
        var meter = await catalog.CreateMeterAsync(body.Code!, body.Name!, body.Aggregation!.Value, ct);
        return Results.Created($"/v1/meters/{meter.Code}", meter);
    }

    private static async Task<IResult> ListTaxRates(string? country, string? after, int? limit, CatalogService catalog, CancellationToken ct) =>
        Results.Ok(await catalog.ListTaxRatesAsync(country, PageQuery.Parse(after, limit), ct));

    private static async Task<IResult> CreateTaxRate(CreateTaxRateRequest body, CatalogService catalog, CancellationToken ct)
    {
        var rate = await catalog.CreateTaxRateAsync(
            new NewTaxRate(body.Country!, body.Region, body.RateBps!.Value, body.ValidFrom!.Value, body.ValidTo),
            ct);
        return Results.Created($"/v1/tax-rates/{rate.Id}", rate);
    }
}
