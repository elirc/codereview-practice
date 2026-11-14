using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Billing.Core.Data.Configurations;

internal sealed class ProductConfiguration : IEntityTypeConfiguration<Product>
{
    public void Configure(EntityTypeBuilder<Product> builder)
    {
        builder.ToTable("products");
        builder.HasKey(p => p.Id);
    }
}

internal sealed class PlanConfiguration : IEntityTypeConfiguration<Plan>
{
    public void Configure(EntityTypeBuilder<Plan> builder)
    {
        builder.ToTable("plans");
        builder.HasKey(p => p.Id);
        builder.HasIndex(p => p.Code).IsUnique().HasDatabaseName("ux_plans_code");
        builder.HasOne<Product>().WithMany().HasForeignKey(p => p.ProductId);
        builder.HasMany(p => p.Items).WithOne().HasForeignKey(i => i.PlanId);
    }
}

internal sealed class PlanItemConfiguration : IEntityTypeConfiguration<PlanItem>
{
    public void Configure(EntityTypeBuilder<PlanItem> builder)
    {
        builder.ToTable("plan_items");
        builder.HasKey(i => i.Id);
        builder.HasIndex(i => new { i.PlanId, i.Position }).IsUnique().HasDatabaseName("ux_plan_items_position");
        builder.HasOne<Meter>().WithMany().HasForeignKey(i => i.MeterCode);
        builder.HasMany(i => i.Tiers).WithOne().HasForeignKey(t => t.PlanItemId);
    }
}

internal sealed class PriceTierConfiguration : IEntityTypeConfiguration<PriceTier>
{
    public void Configure(EntityTypeBuilder<PriceTier> builder)
    {
        builder.ToTable("price_tiers");
        builder.HasKey(t => new { t.PlanItemId, t.Position });
    }
}

internal sealed class MeterConfiguration : IEntityTypeConfiguration<Meter>
{
    public void Configure(EntityTypeBuilder<Meter> builder)
    {
        builder.ToTable("meters");
        builder.HasKey(m => m.Code);
    }
}

internal sealed class TaxRateConfiguration : IEntityTypeConfiguration<TaxRate>
{
    public void Configure(EntityTypeBuilder<TaxRate> builder)
    {
        builder.ToTable("tax_rates");
        builder.HasKey(r => r.Id);
        builder.HasIndex(r => new { r.Country, r.Region }).HasDatabaseName("ix_tax_rates_country_region");
    }
}
