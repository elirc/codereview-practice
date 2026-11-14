using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Billing.Core.Data.Configurations;

internal sealed class CustomerConfiguration : IEntityTypeConfiguration<Customer>
{
    public void Configure(EntityTypeBuilder<Customer> builder)
    {
        builder.ToTable("customers");
        builder.HasKey(c => c.Id);
        builder.HasIndex(c => c.ExternalId).IsUnique().HasDatabaseName("ux_customers_external_id");
    }
}

internal sealed class CreditBalanceTransactionConfiguration : IEntityTypeConfiguration<CreditBalanceTransaction>
{
    public void Configure(EntityTypeBuilder<CreditBalanceTransaction> builder)
    {
        builder.ToTable("credit_balance_transactions");
        builder.HasKey(t => t.Id);
        builder.HasOne<Customer>().WithMany().HasForeignKey(t => t.CustomerId);
        builder.HasOne<Invoice>().WithMany().HasForeignKey(t => t.InvoiceId);
        builder.HasOne<CreditNote>().WithMany().HasForeignKey(t => t.CreditNoteId);
    }
}

internal sealed class CounterConfiguration : IEntityTypeConfiguration<Counter>
{
    public void Configure(EntityTypeBuilder<Counter> builder)
    {
        builder.ToTable("counters");
        builder.HasKey(c => new { c.Name, c.Year });
    }
}

internal sealed class ApiKeyConfiguration : IEntityTypeConfiguration<ApiKey>
{
    public void Configure(EntityTypeBuilder<ApiKey> builder)
    {
        builder.ToTable("api_keys");
        builder.HasKey(k => k.Id);
        builder.HasIndex(k => k.KeyHash).IsUnique().HasDatabaseName("ux_api_keys_key_hash");
    }
}

internal sealed class IdempotencyRecordConfiguration : IEntityTypeConfiguration<IdempotencyRecord>
{
    public void Configure(EntityTypeBuilder<IdempotencyRecord> builder)
    {
        builder.ToTable("idempotency_records");
        builder.HasKey(r => new { r.KeyId, r.Key });
        builder.HasOne<ApiKey>().WithMany().HasForeignKey(r => r.KeyId);
        builder.HasIndex(r => r.CreatedAt).HasDatabaseName("ix_idempotency_records_created_at");
    }
}
