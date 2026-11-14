using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace Billing.Core.Data;

public sealed class BillingDbContext(DbContextOptions<BillingDbContext> options) : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();

    public DbSet<CreditBalanceTransaction> CreditBalanceTransactions => Set<CreditBalanceTransaction>();

    public DbSet<Counter> Counters => Set<Counter>();

    public DbSet<Product> Products => Set<Product>();

    public DbSet<Plan> Plans => Set<Plan>();

    public DbSet<PlanItem> PlanItems => Set<PlanItem>();

    public DbSet<PriceTier> PriceTiers => Set<PriceTier>();

    public DbSet<Meter> Meters => Set<Meter>();

    public DbSet<TaxRate> TaxRates => Set<TaxRate>();

    public DbSet<Subscription> Subscriptions => Set<Subscription>();

    public DbSet<SubscriptionPeriod> SubscriptionPeriods => Set<SubscriptionPeriod>();

    public DbSet<UsageEvent> UsageEvents => Set<UsageEvent>();

    public DbSet<Invoice> Invoices => Set<Invoice>();

    public DbSet<InvoiceLine> InvoiceLines => Set<InvoiceLine>();

    public DbSet<PaymentAttempt> PaymentAttempts => Set<PaymentAttempt>();

    public DbSet<CreditNote> CreditNotes => Set<CreditNote>();

    public DbSet<CreditNoteLine> CreditNoteLines => Set<CreditNoteLine>();

    public DbSet<WebhookEndpoint> WebhookEndpoints => Set<WebhookEndpoint>();

    public DbSet<WebhookEvent> WebhookEvents => Set<WebhookEvent>();

    public DbSet<WebhookDelivery> WebhookDeliveries => Set<WebhookDelivery>();

    public DbSet<ApiKey> ApiKeys => Set<ApiKey>();

    public DbSet<IdempotencyRecord> IdempotencyRecords => Set<IdempotencyRecord>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(BillingDbContext).Assembly);
        ApplyNamingConventions(modelBuilder);
    }

    /// <summary>
    /// Gives every column, key, foreign key and index a snake-case name, stores enums as snake-case text,
    /// leaves primary-key values to the application, and makes foreign keys restrict deletes.
    /// </summary>
    private static void ApplyNamingConventions(ModelBuilder modelBuilder)
    {
        foreach (var entity in modelBuilder.Model.GetEntityTypes())
        {
            var table = entity.GetTableName()
                ?? throw new InvalidOperationException($"{entity.Name} has no table.");

            foreach (var property in entity.GetProperties())
            {
                property.SetColumnName(Naming.ToSnakeCase(property.Name));

                var enumType = Nullable.GetUnderlyingType(property.ClrType) ?? property.ClrType;
                if (enumType.IsEnum)
                {
                    var converterType = typeof(SnakeCaseEnumConverter<>).MakeGenericType(enumType);
                    property.SetValueConverter((ValueConverter)Activator.CreateInstance(converterType)!);
                    property.SetColumnType("text");
                }

                if (property.IsPrimaryKey() && property.ClrType == typeof(Guid))
                {
                    property.ValueGenerated = ValueGenerated.Never;
                }
            }

            foreach (var key in entity.GetKeys())
            {
                key.SetName(key.IsPrimaryKey() ? $"pk_{table}" : $"ak_{table}_{Columns(key.Properties)}");
            }

            foreach (var foreignKey in entity.GetForeignKeys())
            {
                var principalTable = foreignKey.PrincipalEntityType.GetTableName();
                foreignKey.SetConstraintName($"fk_{table}_{principalTable}_{Columns(foreignKey.Properties)}");
                foreignKey.DeleteBehavior = DeleteBehavior.Restrict;
            }

            foreach (var index in entity.GetIndexes())
            {
                if (index.GetDatabaseName() is { } name && name.StartsWith("IX_", StringComparison.Ordinal))
                {
                    index.SetDatabaseName($"ix_{table}_{Columns(index.Properties)}");
                }
            }
        }
    }

    private static string Columns(IEnumerable<IMutableProperty> properties) =>
        string.Join("_", properties.Select(p => Naming.ToSnakeCase(p.Name)));
}
