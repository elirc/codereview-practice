using Billing.Core.Data;
using Billing.Core.Payments;
using Billing.Core.Services;
using Billing.Core.Webhooks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Billing.IntegrationTests.Infrastructure;

/// <summary>Hosts the API against the test database with a manual clock; shared by every integration test.</summary>
public sealed class BillingApp : IAsyncLifetime
{
    public static readonly DateTimeOffset DefaultNow = new(2026, 1, 15, 12, 0, 0, TimeSpan.Zero);

    private BillingFactory? _factory;

    public ManualTimeProvider Clock { get; } = new(DefaultNow);

    public BillingFactory Factory => _factory ?? throw new InvalidOperationException("The test host has not started.");

    public FakeGateway Gateway => Factory.Services.GetRequiredService<FakeGateway>();

    public RecordingWebhookHandler Webhooks { get; } = new();

    public async Task InitializeAsync()
    {
        var url = Environment.GetEnvironmentVariable("TEST_DATABASE_URL")
            ?? "postgres://billing:billing@localhost:5464/billing_test";
        Environment.SetEnvironmentVariable("DATABASE_URL", url);

        _factory = new BillingFactory(url, this);
        await using var scope = _factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<BillingDbContext>().Database.MigrateAsync();
    }

    public async Task DisposeAsync()
    {
        if (_factory is not null)
        {
            await _factory.DisposeAsync();
        }
    }

    /// <summary>Empties every table and puts the clock back to its default.</summary>
    public async Task ResetAsync()
    {
        Clock.Set(DefaultNow);
        Gateway.Reset();
        Webhooks.Reset();
        await using var scope = Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var tables = await db.Database
            .SqlQuery<string>($"SELECT tablename AS \"Value\" FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__EFMigrationsHistory'")
            .ToListAsync();
        var sql = "TRUNCATE TABLE " + string.Join(", ", tables.Select(t => "\"" + t + "\"")) + " RESTART IDENTITY CASCADE";
        await db.Database.ExecuteSqlRawAsync(sql);
    }

    /// <summary>Creates an API key with the role and returns a client that uses it.</summary>
    public async Task<ApiClient> ClientAsync(ApiRole role)
    {
        var plain = $"bk_test_{Naming.EnumValue(role)}_{Guid.NewGuid():N}";
        await WithDbAsync(async db =>
        {
            db.ApiKeys.Add(new ApiKey
            {
                Id = Guid.NewGuid(),
                Name = $"test {role}",
                KeyHash = Hashing.Sha256Hex(plain),
                Role = role,
                CreatedAt = Clock.GetUtcNow(),
            });
            await db.SaveChangesAsync();
        });
        return new ApiClient(Factory.CreateClient(), plain);
    }

    /// <summary>Returns a client that sends no API key.</summary>
    public ApiClient AnonymousClient() => new(Factory.CreateClient(), null);

    public AsyncServiceScope Scope() => Factory.Services.CreateAsyncScope();

    /// <summary>Runs the action against a fresh context in its own scope.</summary>
    public async Task WithDbAsync(Func<BillingDbContext, Task> action)
    {
        await using var scope = Scope();
        await action(scope.ServiceProvider.GetRequiredService<BillingDbContext>());
    }

    /// <summary>Runs the query against a fresh context in its own scope.</summary>
    public async Task<T> WithDbAsync<T>(Func<BillingDbContext, Task<T>> query)
    {
        await using var scope = Scope();
        return await query(scope.ServiceProvider.GetRequiredService<BillingDbContext>());
    }

    /// <summary>Runs one pass of the loop runner at the current manual time.</summary>
    public async Task RunLoopAsync<TRunner>()
        where TRunner : ILoopRunner
    {
        await using var scope = Scope();
        await scope.ServiceProvider.GetRequiredService<TRunner>().RunOnceAsync(Clock.GetUtcNow(), default);
    }

    /// <summary>Resolves a scoped service and runs the action with it.</summary>
    public async Task RunAsync<TService>(Func<TService, Task> action)
        where TService : notnull
    {
        await using var scope = Scope();
        await action(scope.ServiceProvider.GetRequiredService<TService>());
    }
}

/// <summary>The API host used by the tests.</summary>
public sealed class BillingFactory(string databaseUrl, BillingApp app) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("DATABASE_URL", databaseUrl);
        builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<TimeProvider>(app.Clock);
            services.AddHttpClient(WebhookSender.ClientName)
                .ConfigurePrimaryHttpMessageHandler(() => app.Webhooks)
                .SetHandlerLifetime(Timeout.InfiniteTimeSpan);
        });
    }
}

[CollectionDefinition(Name)]
public sealed class DatabaseCollection : ICollectionFixture<BillingApp>
{
    public const string Name = "database";
}

/// <summary>Base class of integration tests: resets the database before each test.</summary>
[Collection(DatabaseCollection.Name)]
public abstract class IntegrationTest(BillingApp app) : IAsyncLifetime
{
    private TestData? _data;

    protected BillingApp App => app;

    protected ManualTimeProvider Clock => app.Clock;

    protected TestData Data => _data ??= new TestData(app);

    public virtual Task InitializeAsync() => app.ResetAsync();

    public Task DisposeAsync() => Task.CompletedTask;
}
