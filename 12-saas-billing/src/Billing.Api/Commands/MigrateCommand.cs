using Billing.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Billing.Api.Commands;

/// <summary>Applies pending EF Core migrations to the configured database.</summary>
public static class MigrateCommand
{
    public static async Task<int> RunAsync(IServiceProvider services, CancellationToken ct = default)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var logger = scope.ServiceProvider.GetRequiredService<ILoggerFactory>().CreateLogger("Billing.Migrate");

        var pending = (await db.Database.GetPendingMigrationsAsync(ct)).ToList();
        logger.LogInformation("Applying {Count} pending migrations", pending.Count);
        await db.Database.MigrateAsync(ct);
        logger.LogInformation("Database is up to date");
        return 0;
    }
}
