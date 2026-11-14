using Billing.Core.Data;
using Billing.IntegrationTests.Infrastructure;
using Xunit;

namespace Billing.IntegrationTests;

[Collection(DatabaseCollection.Name)]
public sealed class PermissionMatrixTests(BillingApp app) : IntegrationTest(app)
{
    private static readonly ApiRole[] All = [ApiRole.Service, ApiRole.Support, ApiRole.BillingOps, ApiRole.Admin];
    private static readonly ApiRole[] Writers = [ApiRole.Service, ApiRole.BillingOps, ApiRole.Admin];
    private static readonly ApiRole[] Ops = [ApiRole.BillingOps, ApiRole.Admin];
    private static readonly ApiRole[] AdminOnly = [ApiRole.Admin];
    private static readonly ApiRole[] ServiceOnly = [ApiRole.Service];

    private sealed record Rule(string Method, string Path, object? Body, ApiRole[] Allowed);

    [Fact]
    public async Task EveryRoleGetsExactlyThePermissionsOfTheMatrix()
    {
        var id = Guid.NewGuid();
        var rules = new List<Rule>
        {
            new("GET", "/v1/customers", null, All),
            new("GET", $"/v1/customers/{id}", null, All),
            new("POST", "/v1/customers", new { externalId = "x" }, Writers),
            new("PATCH", $"/v1/customers/{id}", new { name = "x" }, Writers),
            new("PUT", $"/v1/customers/{id}/payment-method", new { token = "tok_ok" }, Writers),
            new("GET", $"/v1/customers/{id}/credit-transactions", null, All),
            new("POST", $"/v1/customers/{id}/credit-adjustments", new { amountMinor = 1, reason = "x" }, Ops),
            new("GET", "/v1/products", null, All),
            new("POST", "/v1/products", new { name = "x" }, AdminOnly),
            new("GET", "/v1/plans", null, All),
            new("POST", "/v1/plans", new { code = "x" }, AdminOnly),
            new("POST", "/v1/plans/x/retire", null, AdminOnly),
            new("POST", "/v1/meters", new { code = "x" }, AdminOnly),
            new("POST", "/v1/tax-rates", new { country = "US" }, AdminOnly),
            new("GET", "/v1/subscriptions", null, All),
            new("GET", $"/v1/subscriptions/{id}", null, All),
            new("POST", "/v1/subscriptions", new { planCode = "x" }, Writers),
            new("POST", $"/v1/subscriptions/{id}/change", new { quantity = 2 }, Writers),
            new("POST", $"/v1/subscriptions/{id}/cancel", new { mode = "immediate" }, Writers),
            new("POST", $"/v1/subscriptions/{id}/resume", null, Writers),
            new("GET", $"/v1/subscriptions/{id}/usage", null, All),
            new("POST", "/v1/usage-events", new { events = Array.Empty<object>() }, ServiceOnly),
            new("GET", "/v1/invoices", null, All),
            new("GET", $"/v1/invoices/{id}", null, All),
            new("POST", "/v1/invoices", new { customerId = id }, Ops),
            new("PUT", $"/v1/invoices/{id}/lines", new { lines = Array.Empty<object>() }, Ops),
            new("POST", $"/v1/invoices/{id}/finalize", null, Ops),
            new("POST", $"/v1/invoices/{id}/void", null, Ops),
            new("POST", $"/v1/invoices/{id}/pay", null, Ops),
            new("POST", $"/v1/invoices/{id}/credit-notes", new { reason = "x" }, Ops),
            new("GET", $"/v1/credit-notes/{id}", null, All),
            new("GET", "/v1/webhook-endpoints", null, Ops),
            new("POST", "/v1/webhook-endpoints", new { url = "https://hooks.test/x" }, AdminOnly),
            new("PATCH", $"/v1/webhook-endpoints/{id}", new { status = "disabled" }, AdminOnly),
            new("POST", $"/v1/webhook-endpoints/{id}/rotate-secret", null, AdminOnly),
            new("GET", "/v1/webhook-deliveries", null, Ops),
            new("POST", $"/v1/webhook-deliveries/{id}/retry", null, Ops),
            new("POST", "/v1/api-keys", new { name = "x", role = "support" }, AdminOnly),
            new("DELETE", $"/v1/api-keys/{id}", null, AdminOnly),
        };

        var clients = new Dictionary<ApiRole, ApiClient>();
        foreach (var role in All)
        {
            clients[role] = await App.ClientAsync(role);
        }

        var mismatches = new List<string>();
        foreach (var rule in rules)
        {
            foreach (var role in All)
            {
                var response = await SendAsync(clients[role], rule);
                var allowed = rule.Allowed.Contains(role);
                if (allowed && response.Status is 401 or 403)
                {
                    mismatches.Add($"{role} should be allowed {rule.Method} {rule.Path} but got {response.Status}");
                }

                if (!allowed && response.Status != 403)
                {
                    mismatches.Add($"{role} should be forbidden {rule.Method} {rule.Path} but got {response.Status}");
                }

                if (!allowed && response.Status == 403)
                {
                    Assert.Equal("forbidden", response.ErrorCode);
                }
            }
        }

        Assert.Empty(mismatches);
    }

    [Fact]
    public async Task ForbiddenRoleIsRefusedBeforeTheBodyIsRead()
    {
        var support = await App.ClientAsync(ApiRole.Support);

        var malformed = await support.PostRawAsync("/v1/customers", "{ not json");
        var unknownField = await support.PostRawAsync("/v1/products", """{"name":"x","extra":1}""");

        Assert.Equal(403, malformed.Status);
        Assert.Equal(403, unknownField.Status);
    }

    [Fact]
    public async Task EveryApiRouteRequiresAKey()
    {
        var anonymous = App.AnonymousClient();

        var responses = await Task.WhenAll(
            anonymous.GetAsync("/v1/invoices"),
            anonymous.PostAsync("/v1/usage-events", new { events = Array.Empty<object>() }),
            anonymous.GetAsync("/v1/webhook-deliveries"));

        Assert.All(responses, r => Assert.Equal(401, r.Status));
        Assert.Equal(200, (await anonymous.GetAsync("/health")).Status);
    }

    private static Task<ApiResponse> SendAsync(ApiClient client, Rule rule) => rule.Method switch
    {
        "GET" => client.GetAsync(rule.Path),
        "POST" => client.PostAsync(rule.Path, rule.Body ?? new { }, idempotencyKey: "permission-matrix-key"),
        "PUT" => client.PutAsync(rule.Path, rule.Body ?? new { }),
        "PATCH" => client.PatchAsync(rule.Path, rule.Body ?? new { }),
        "DELETE" => client.DeleteAsync(rule.Path),
        _ => throw new ArgumentOutOfRangeException(nameof(rule)),
    };
}
