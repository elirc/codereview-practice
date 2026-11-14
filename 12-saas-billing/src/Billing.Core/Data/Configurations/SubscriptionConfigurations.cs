using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Billing.Core.Data.Configurations;

internal sealed class SubscriptionConfiguration : IEntityTypeConfiguration<Subscription>
{
    public void Configure(EntityTypeBuilder<Subscription> builder)
    {
        builder.ToTable("subscriptions");
        builder.HasKey(s => s.Id);
        builder.HasOne<Customer>().WithMany().HasForeignKey(s => s.CustomerId);
        builder.HasOne<Product>().WithMany().HasForeignKey(s => s.ProductId);
        builder.HasOne<Plan>().WithMany().HasForeignKey(s => s.PlanId);
        builder.HasOne<Plan>().WithMany().HasForeignKey(s => s.PendingPlanId);
        builder.HasIndex(s => s.NextBillingAt).HasDatabaseName("ix_subscriptions_next_billing_at");
    }
}

internal sealed class SubscriptionPeriodConfiguration : IEntityTypeConfiguration<SubscriptionPeriod>
{
    public void Configure(EntityTypeBuilder<SubscriptionPeriod> builder)
    {
        builder.ToTable("subscription_periods");
        builder.HasKey(p => p.Id);
        builder.HasOne<Subscription>().WithMany().HasForeignKey(p => p.SubscriptionId);
        builder.HasOne<Plan>().WithMany().HasForeignKey(p => p.PlanId);
        builder.HasIndex(p => new { p.SubscriptionId, p.Index }).IsUnique().HasDatabaseName("ux_subscription_periods_index");
    }
}

internal sealed class UsageEventConfiguration : IEntityTypeConfiguration<UsageEvent>
{
    public void Configure(EntityTypeBuilder<UsageEvent> builder)
    {
        builder.ToTable("usage_events");
        builder.HasKey(e => e.Id);
        builder.HasOne<Subscription>().WithMany().HasForeignKey(e => e.SubscriptionId);
        builder.HasOne<Meter>().WithMany().HasForeignKey(e => e.MeterCode);
        builder.HasOne<SubscriptionPeriod>().WithMany().HasForeignKey(e => e.BilledPeriodId);
        builder.HasIndex(e => new { e.SubscriptionId, e.EventKey }).IsUnique().HasDatabaseName("ux_usage_events_key");
    }
}
