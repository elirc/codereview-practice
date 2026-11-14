using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Billing.Core.Data.Configurations;

internal sealed class WebhookEndpointConfiguration : IEntityTypeConfiguration<WebhookEndpoint>
{
    public void Configure(EntityTypeBuilder<WebhookEndpoint> builder)
    {
        builder.ToTable("webhook_endpoints");
        builder.HasKey(e => e.Id);
    }
}

internal sealed class WebhookEventConfiguration : IEntityTypeConfiguration<WebhookEvent>
{
    public void Configure(EntityTypeBuilder<WebhookEvent> builder)
    {
        builder.ToTable("webhook_events");
        builder.HasKey(e => e.Id);
        builder.Property(e => e.Sequence).UseIdentityByDefaultColumn();
        builder.HasIndex(e => e.Sequence).IsUnique().HasDatabaseName("ux_webhook_events_sequence");
    }
}

internal sealed class WebhookDeliveryConfiguration : IEntityTypeConfiguration<WebhookDelivery>
{
    public void Configure(EntityTypeBuilder<WebhookDelivery> builder)
    {
        builder.ToTable("webhook_deliveries");
        builder.HasKey(d => d.Id);
        builder.HasOne<WebhookEvent>().WithMany().HasForeignKey(d => d.EventId);
        builder.HasOne<WebhookEndpoint>().WithMany().HasForeignKey(d => d.EndpointId);
        builder.HasIndex(d => new { d.EventId, d.EndpointId }).IsUnique().HasDatabaseName("ux_webhook_deliveries_event_endpoint");
        builder.HasIndex(d => new { d.EndpointId, d.ObjectId, d.Sequence }).HasDatabaseName("ix_webhook_deliveries_endpoint_object");
    }
}
