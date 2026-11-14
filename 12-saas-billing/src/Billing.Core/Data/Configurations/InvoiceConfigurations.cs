using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Billing.Core.Data.Configurations;

internal sealed class InvoiceConfiguration : IEntityTypeConfiguration<Invoice>
{
    public void Configure(EntityTypeBuilder<Invoice> builder)
    {
        builder.ToTable("invoices");
        builder.HasKey(i => i.Id);
        builder.HasIndex(i => i.Number).IsUnique().HasDatabaseName("ux_invoices_number");
        builder.HasOne<Customer>().WithMany().HasForeignKey(i => i.CustomerId);
        builder.HasOne<Subscription>().WithMany().HasForeignKey(i => i.SubscriptionId);
        builder.HasMany(i => i.Lines).WithOne().HasForeignKey(l => l.InvoiceId);
    }
}

internal sealed class InvoiceLineConfiguration : IEntityTypeConfiguration<InvoiceLine>
{
    public void Configure(EntityTypeBuilder<InvoiceLine> builder)
    {
        builder.ToTable("invoice_lines");
        builder.HasKey(l => l.Id);
        builder.HasIndex(l => new { l.InvoiceId, l.LineNo }).IsUnique().HasDatabaseName("ux_invoice_lines_line_no");
        builder.HasOne<PlanItem>().WithMany().HasForeignKey(l => l.PlanItemId);
    }
}

internal sealed class PaymentAttemptConfiguration : IEntityTypeConfiguration<PaymentAttempt>
{
    public void Configure(EntityTypeBuilder<PaymentAttempt> builder)
    {
        builder.ToTable("payment_attempts");
        builder.HasKey(a => a.Id);
        builder.HasOne<Invoice>().WithMany().HasForeignKey(a => a.InvoiceId);
        builder.HasIndex(a => new { a.InvoiceId, a.AttemptNo }).IsUnique().HasDatabaseName("ux_payment_attempts_attempt_no");
        builder.HasIndex(a => a.IdempotencyKey).IsUnique().HasDatabaseName("ux_payment_attempts_idempotency_key");
    }
}

internal sealed class CreditNoteConfiguration : IEntityTypeConfiguration<CreditNote>
{
    public void Configure(EntityTypeBuilder<CreditNote> builder)
    {
        builder.ToTable("credit_notes");
        builder.HasKey(n => n.Id);
        builder.HasIndex(n => n.Number).IsUnique().HasDatabaseName("ux_credit_notes_number");
        builder.HasOne<Invoice>().WithMany().HasForeignKey(n => n.InvoiceId);
        builder.HasOne<ApiKey>().WithMany().HasForeignKey(n => n.CreatedByKeyId);
        builder.HasMany(n => n.Lines).WithOne().HasForeignKey(l => l.CreditNoteId);
    }
}

internal sealed class CreditNoteLineConfiguration : IEntityTypeConfiguration<CreditNoteLine>
{
    public void Configure(EntityTypeBuilder<CreditNoteLine> builder)
    {
        builder.ToTable("credit_note_lines");
        builder.HasKey(l => new { l.CreditNoteId, l.InvoiceLineId });
        builder.HasOne<InvoiceLine>().WithMany().HasForeignKey(l => l.InvoiceLineId);
    }
}
