using Billing.Core.Data;
using Billing.IntegrationTests.Infrastructure;
using Xunit;

namespace Billing.IntegrationTests;

public sealed class CustomerAndCatalogTests(BillingApp app) : IntegrationTest(app)
{
    [Fact]
    public async Task CreatedCustomerCanBeReadBack()
    {
        var id = await Data.CustomerAsync(timezone: "Pacific/Auckland", country: "NZ", currency: "USD");
        var support = await App.ClientAsync(ApiRole.Support);

        var response = await support.GetAsync($"/v1/customers/{id}");

        Assert.Equal(200, response.Status);
        Assert.Equal("Pacific/Auckland", response["timezone"].GetString());
        Assert.True(response["hasPaymentMethod"].GetBoolean());
        Assert.Equal(0, response["creditBalanceMinor"].GetInt64());
    }

    [Fact]
    public async Task DuplicateExternalIdIsAConflict()
    {
        var service = await Data.ServiceAsync();
        var body = new { externalId = "acme", name = "Acme", email = "a@acme.test", currency = "USD", timezone = "Etc/UTC", country = "US" };

        Assert.Equal(201, (await service.PostAsync("/v1/customers", body)).Status);
        var second = await service.PostAsync("/v1/customers", body);

        Assert.Equal(409, second.Status);
        Assert.Equal("already_exists", second.ErrorCode);
    }

    [Fact]
    public async Task InvalidFieldsAreReportedTogether()
    {
        var service = await Data.ServiceAsync();

        var response = await service.PostAsync(
            "/v1/customers",
            new { externalId = "x", name = "X", email = "not-an-email", currency = "JPY", timezone = "Mars/Olympus", country = "usa" });

        Assert.Equal(400, response.Status);
        Assert.Equal("validation_failed", response.ErrorCode);
        var paths = response["error"].GetProperty("details").GetProperty("fields").EnumerateArray()
            .Select(f => f.GetProperty("path").GetString())
            .ToList();
        Assert.Equal(new[] { "email", "currency", "timezone", "country" }, paths);
        Assert.False(string.IsNullOrEmpty(response["error"].GetProperty("requestId").GetString()));
    }

    [Fact]
    public async Task UnknownFieldsAreRejected()
    {
        var service = await Data.ServiceAsync();

        var response = await service.PostRawAsync(
            "/v1/customers",
            """{"externalId":"x","name":"X","email":"x@x.test","currency":"USD","timezone":"Etc/UTC","country":"US","vip":true}""");

        Assert.Equal(400, response.Status);
        Assert.Equal("validation_failed", response.ErrorCode);
    }

    [Fact]
    public async Task NumbersSentAsStringsAreRejected()
    {
        var admin = await Data.AdminAsync();

        var response = await admin.PostRawAsync(
            "/v1/tax-rates",
            """{"country":"US","rateBps":"500","validFrom":"2026-01-01"}""");

        Assert.Equal(400, response.Status);
    }

    [Fact]
    public async Task RequestsWithoutAValidKeyAreUnauthenticated()
    {
        var anonymous = App.AnonymousClient();

        var response = await anonymous.GetAsync("/v1/customers");

        Assert.Equal(401, response.Status);
        Assert.Equal("unauthenticated", response.ErrorCode);
    }

    [Fact]
    public async Task RevokedKeysStopWorking()
    {
        var admin = await Data.AdminAsync();
        var created = await admin.PostAsync("/v1/api-keys", new { name = "integration", role = "support" });
        Assert.Equal(201, created.Status);
        var key = created["key"].GetString()!;
        var client = new ApiClient(App.Factory.CreateClient(), key);
        Assert.Equal(200, (await client.GetAsync("/v1/customers")).Status);

        Assert.Equal(204, (await admin.DeleteAsync($"/v1/api-keys/{created.Id}")).Status);

        Assert.Equal(401, (await client.GetAsync("/v1/customers")).Status);
    }

    [Fact]
    public async Task CustomerListPagesWithACursor()
    {
        for (var i = 0; i < 3; i++)
        {
            await Data.CustomerAsync();
        }

        var support = await App.ClientAsync(ApiRole.Support);

        var first = await support.GetAsync("/v1/customers?limit=2");
        var cursor = first["nextCursor"].GetString();
        var second = await support.GetAsync($"/v1/customers?limit=2&after={cursor}");

        Assert.Equal(2, first["data"].GetArrayLength());
        Assert.Equal(1, second["data"].GetArrayLength());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, second["nextCursor"].ValueKind);
    }

    [Fact]
    public async Task PlanIsCreatedWithItemsAndTiers()
    {
        var product = await Data.ProductAsync();
        await Data.MeterAsync("api_calls");

        var plan = await Data.PlanAsync(
            product,
            "pro-monthly",
            [Items.Flat("Platform", 5000), Items.Seats("Seats", 1000), Items.Usage("api_calls", "graduated", (1000, 0, 0), (null, 2, 0))]);

        Assert.Equal(3, plan.GetProperty("items").GetArrayLength());
        var usage = plan.GetProperty("items")[2];
        Assert.Equal("usage", usage.GetProperty("kind").GetString());
        Assert.Equal("graduated", usage.GetProperty("tierMode").GetString());
        Assert.Equal(2, usage.GetProperty("tiers").GetArrayLength());
    }

    [Fact]
    public async Task PlanWithMalformedTiersIsRejected()
    {
        var product = await Data.ProductAsync();
        await Data.MeterAsync("api_calls");
        var admin = await Data.AdminAsync();

        var response = await admin.PostAsync(
            "/v1/plans",
            new
            {
                productId = product,
                code = "broken",
                name = "Broken",
                interval = "month",
                currency = "USD",
                items = new[] { Items.Usage("api_calls", "volume", (1000, 1, 0), (500, 1, 0), (null, 1, 0)) },
            });

        Assert.Equal(400, response.Status);
        Assert.Equal("validation_failed", response.ErrorCode);
    }

    [Fact]
    public async Task PlanWithTwoSeatItemsIsRejected()
    {
        var product = await Data.ProductAsync();
        var admin = await Data.AdminAsync();

        var response = await admin.PostAsync(
            "/v1/plans",
            new
            {
                productId = product,
                code = "two-seats",
                name = "Two seats",
                interval = "month",
                currency = "USD",
                items = new[] { Items.Seats("A", 100), Items.Seats("B", 100) },
            });

        Assert.Equal(400, response.Status);
    }

    [Fact]
    public async Task RetiredPlanIsInactive()
    {
        var product = await Data.ProductAsync();
        await Data.PlanAsync(product, "basic", [Items.Flat("Basic", 3000)]);
        var admin = await Data.AdminAsync();

        var retired = await admin.PostAsync("/v1/plans/basic/retire");

        Assert.Equal(200, retired.Status);
        Assert.False(retired["active"].GetBoolean());
    }

    [Fact]
    public async Task OverlappingTaxRatesAreRefusedAndAdjacentOnesAccepted()
    {
        var admin = await Data.AdminAsync();
        await Data.TaxRateAsync("US", "CA", 825, "2026-01-01", "2026-07-01");

        var overlapping = await admin.PostAsync("/v1/tax-rates", new { country = "US", region = "CA", rateBps = 900, validFrom = "2026-06-01" });
        var adjacent = await admin.PostAsync("/v1/tax-rates", new { country = "US", region = "CA", rateBps = 900, validFrom = "2026-07-01" });
        var national = await admin.PostAsync("/v1/tax-rates", new { country = "US", rateBps = 500, validFrom = "2026-01-01" });

        Assert.Equal(422, overlapping.Status);
        Assert.Equal("tax_rate_overlap", overlapping.ErrorCode);
        Assert.Equal(201, adjacent.Status);
        Assert.Equal(201, national.Status);
    }

    [Fact]
    public async Task UnknownRoutesAreNotFound()
    {
        var support = await App.ClientAsync(ApiRole.Support);

        var response = await support.GetAsync($"/v1/customers/{Guid.NewGuid()}");

        Assert.Equal(404, response.Status);
        Assert.Equal("not_found", response.ErrorCode);
    }
}
