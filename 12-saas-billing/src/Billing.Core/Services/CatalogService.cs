using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Views;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Billing.Core.Services;

public sealed record NewPlan(
    Guid ProductId,
    string Code,
    string Name,
    BillingInterval Interval,
    string Currency,
    int TrialDays,
    IReadOnlyList<NewPlanItem> Items);

public sealed record NewPlanItem(
    PlanItemKind Kind,
    string Name,
    long? UnitAmountMinor,
    string? MeterCode,
    TierMode? TierMode,
    IReadOnlyList<PriceTierSpec> Tiers);

public sealed record NewTaxRate(string Country, string? Region, int RateBps, DateOnly ValidFrom, DateOnly? ValidTo);

/// <summary>Manages products, plans, meters and tax rates.</summary>
public sealed class CatalogService(BillingDbContext db, TimeProvider clock)
{
    public async Task<ProductView> CreateProductAsync(string name, CancellationToken ct)
    {
        var product = new Product { Id = Ids.New(clock), Name = name, Active = true, CreatedAt = clock.GetUtcNow() };
        db.Products.Add(product);
        await db.SaveChangesAsync(ct);
        return ProductView.From(product);
    }

    public async Task<Page<ProductView>> ListProductsAsync(PageRequest page, CancellationToken ct)
    {
        IQueryable<Product> source = page.AfterId() is { } after
            ? db.Products.FromSql($"SELECT * FROM products WHERE id > {after}")
            : db.Products;
        var rows = await source.AsNoTracking().OrderBy(p => p.Id).Take(page.Limit + 1).ToListAsync(ct);
        return Paging.Build(rows, page.Limit, p => p.Id.ToString(), ProductView.From);
    }

    /// <summary>Creates a plan with its items and tiers in one step.</summary>
    public async Task<PlanView> CreatePlanAsync(NewPlan input, CancellationToken ct)
    {
        if (!await db.Products.AnyAsync(p => p.Id == input.ProductId, ct))
        {
            throw DomainException.NotFound("Product");
        }

        var meterCodes = input.Items.Where(i => i.MeterCode is not null).Select(i => i.MeterCode!).Distinct().ToList();
        var knownMeters = await db.Meters.Where(m => meterCodes.Contains(m.Code)).Select(m => m.Code).ToListAsync(ct);
        var unknown = input.Items
            .Select((item, index) => (item, index))
            .Where(x => x.item.MeterCode is not null && !knownMeters.Contains(x.item.MeterCode))
            .Select(x => new FieldError($"items[{x.index}].meterCode", "Is not a known meter."))
            .ToList();
        if (unknown.Count > 0)
        {
            throw DomainException.Validation(unknown);
        }

        var plan = new Plan
        {
            Id = Ids.New(clock),
            ProductId = input.ProductId,
            Code = input.Code,
            Name = input.Name,
            Interval = input.Interval,
            Currency = input.Currency,
            TrialDays = input.TrialDays,
            Active = true,
            CreatedAt = clock.GetUtcNow(),
        };
        db.Plans.Add(plan);

        for (var position = 0; position < input.Items.Count; position++)
        {
            var source = input.Items[position];
            var item = new PlanItem
            {
                Id = Ids.New(clock),
                PlanId = plan.Id,
                Position = position,
                Kind = source.Kind,
                Name = source.Name,
                UnitAmountMinor = source.Kind == PlanItemKind.Usage ? null : source.UnitAmountMinor,
                MeterCode = source.Kind == PlanItemKind.Usage ? source.MeterCode : null,
                TierMode = source.Kind == PlanItemKind.Usage ? source.TierMode : null,
            };
            db.PlanItems.Add(item);
            plan.Items.Add(item);

            if (source.Kind != PlanItemKind.Usage)
            {
                continue;
            }

            for (var tierPosition = 0; tierPosition < source.Tiers.Count; tierPosition++)
            {
                var spec = source.Tiers[tierPosition];
                var tier = new PriceTier
                {
                    PlanItemId = item.Id,
                    Position = tierPosition,
                    UpTo = spec.UpTo,
                    UnitAmountMinor = spec.UnitAmountMinor,
                    FlatAmountMinor = spec.FlatAmountMinor,
                };
                db.PriceTiers.Add(tier);
                item.Tiers.Add(tier);
            }
        }

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.IsUniqueViolation("ux_plans_code"))
        {
            throw DomainException.Conflict(ErrorCodes.AlreadyExists, "A plan with this code already exists.");
        }

        return PlanView.From(plan);
    }

    public async Task<Page<PlanView>> ListPlansAsync(Guid? productId, PageRequest page, CancellationToken ct)
    {
        IQueryable<Plan> source = page.AfterId() is { } after
            ? db.Plans.FromSql($"SELECT * FROM plans WHERE id > {after}")
            : db.Plans;
        if (productId is { } product)
        {
            source = source.Where(p => p.ProductId == product);
        }

        var rows = await source
            .AsNoTracking()
            .Include(p => p.Items)
            .ThenInclude(i => i.Tiers)
            .OrderBy(p => p.Id)
            .Take(page.Limit + 1)
            .AsSplitQuery()
            .ToListAsync(ct);
        return Paging.Build(rows, page.Limit, p => p.Id.ToString(), PlanView.From);
    }

    public async Task<PlanView> GetPlanAsync(string code, CancellationToken ct) =>
        PlanView.From(await LoadPlanAsync(code, ct) ?? throw DomainException.NotFound("Plan"));

    /// <summary>Marks the plan inactive so it can no longer be subscribed to.</summary>
    public async Task<PlanView> RetirePlanAsync(string code, CancellationToken ct)
    {
        var plan = await db.Plans
            .Include(p => p.Items)
            .ThenInclude(i => i.Tiers)
            .SingleOrDefaultAsync(p => p.Code == code, ct)
            ?? throw DomainException.NotFound("Plan");
        plan.Active = false;
        await db.SaveChangesAsync(ct);
        return PlanView.From(plan);
    }

    /// <summary>Loads a plan with its items and tiers, without tracking; returns null when the code is unknown.</summary>
    public Task<Plan?> LoadPlanAsync(string code, CancellationToken ct) =>
        db.Plans.AsNoTracking().Include(p => p.Items).ThenInclude(i => i.Tiers).SingleOrDefaultAsync(p => p.Code == code, ct);

    public async Task<MeterView> CreateMeterAsync(string code, string name, MeterAggregation aggregation, CancellationToken ct)
    {
        var meter = new Meter { Code = code, Name = name, Aggregation = aggregation, CreatedAt = clock.GetUtcNow() };
        db.Meters.Add(meter);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.IsUniqueViolation("pk_meters"))
        {
            throw DomainException.Conflict(ErrorCodes.AlreadyExists, "A meter with this code already exists.");
        }

        return MeterView.From(meter);
    }

    public async Task<Page<MeterView>> ListMetersAsync(PageRequest page, CancellationToken ct)
    {
        IQueryable<Meter> source = page.After is { } after
            ? db.Meters.FromSql($"SELECT * FROM meters WHERE code > {after}")
            : db.Meters;
        var rows = await source.AsNoTracking().OrderBy(m => m.Code).Take(page.Limit + 1).ToListAsync(ct);
        return Paging.Build(rows, page.Limit, m => m.Code, MeterView.From);
    }

    /// <summary>Creates a tax rate; a range overlapping another rate of the same country and region is refused.</summary>
    public async Task<TaxRateView> CreateTaxRateAsync(NewTaxRate input, CancellationToken ct)
    {
        var rate = new TaxRate
        {
            Id = Ids.New(clock),
            Country = input.Country,
            Region = input.Region,
            RateBps = input.RateBps,
            ValidFrom = input.ValidFrom,
            ValidTo = input.ValidTo,
            CreatedAt = clock.GetUtcNow(),
        };
        db.TaxRates.Add(rate);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.IsExclusionViolation())
        {
            throw DomainException.Unprocessable(ErrorCodes.TaxRateOverlap, "The validity range overlaps another rate for the same country and region.");
        }

        return TaxRateView.From(rate);
    }

    public async Task<Page<TaxRateView>> ListTaxRatesAsync(string? country, PageRequest page, CancellationToken ct)
    {
        IQueryable<TaxRate> source = page.AfterId() is { } after
            ? db.TaxRates.FromSql($"SELECT * FROM tax_rates WHERE id > {after}")
            : db.TaxRates;
        if (country is not null)
        {
            source = source.Where(r => r.Country == country);
        }

        var rows = await source.AsNoTracking().OrderBy(r => r.Id).Take(page.Limit + 1).ToListAsync(ct);
        return Paging.Build(rows, page.Limit, r => r.Id.ToString(), TaxRateView.From);
    }
}
