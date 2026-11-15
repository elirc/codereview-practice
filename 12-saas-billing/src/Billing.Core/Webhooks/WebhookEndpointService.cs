using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Services;
using Microsoft.EntityFrameworkCore;

namespace Billing.Core.Webhooks;

public sealed record WebhookEndpointView(
    Guid Id,
    string Url,
    IReadOnlyList<string> EventTypes,
    WebhookEndpointStatus Status,
    DateTimeOffset? PreviousSecretExpiresAt,
    DateTimeOffset CreatedAt)
{
    public static WebhookEndpointView From(WebhookEndpoint e) => new(e.Id, e.Url, e.EventTypes, e.Status, e.PreviousSecretExpiresAt, e.CreatedAt);
}

/// <summary>An endpoint together with its signing secret, returned only on create and rotate.</summary>
public sealed record WebhookEndpointWithSecretView(
    Guid Id,
    string Url,
    IReadOnlyList<string> EventTypes,
    WebhookEndpointStatus Status,
    string Secret,
    DateTimeOffset? PreviousSecretExpiresAt,
    DateTimeOffset CreatedAt)
{
    public static WebhookEndpointWithSecretView From(WebhookEndpoint e) =>
        new(e.Id, e.Url, e.EventTypes, e.Status, e.Secret, e.PreviousSecretExpiresAt, e.CreatedAt);
}

/// <summary>Number of deliveries of an endpoint in each status.</summary>
public sealed record WebhookDeliveryCounts(int Pending, int Succeeded, int Failed);

/// <summary>An endpoint together with a summary of its deliveries.</summary>
public sealed record WebhookEndpointDetailView(
    Guid Id,
    string Url,
    IReadOnlyList<string> EventTypes,
    WebhookEndpointStatus Status,
    string Secret,
    DateTimeOffset? PreviousSecretExpiresAt,
    DateTimeOffset CreatedAt,
    WebhookDeliveryCounts Deliveries,
    DateTimeOffset? LastDeliveredAt);

public sealed record WebhookEndpointChanges(string? Url, IReadOnlyList<string>? EventTypes, WebhookEndpointStatus? Status);

/// <summary>Manages webhook endpoints and their signing secrets.</summary>
public sealed class WebhookEndpointService(BillingDbContext db, TimeProvider clock, ISecretGenerator secrets, BillingSettings settings)
{
    public const string SecretPrefix = "whsec_";
    public const string AllEvents = "*";
    public static readonly TimeSpan RotationOverlap = TimeSpan.FromHours(24);

    public async Task<WebhookEndpointWithSecretView> CreateAsync(string url, IReadOnlyList<string> eventTypes, CancellationToken ct)
    {
        EnsureUrlAllowed(url);
        var endpoint = new WebhookEndpoint
        {
            Id = Ids.New(clock),
            Url = url,
            Secret = secrets.NewToken(SecretPrefix),
            EventTypes = [.. eventTypes.Distinct(StringComparer.Ordinal)],
            Status = WebhookEndpointStatus.Enabled,
            CreatedAt = clock.GetUtcNow(),
        };
        db.WebhookEndpoints.Add(endpoint);
        await db.SaveChangesAsync(ct);
        return WebhookEndpointWithSecretView.From(endpoint);
    }

    public async Task<Page<WebhookEndpointView>> ListAsync(PageRequest page, CancellationToken ct)
    {
        IQueryable<WebhookEndpoint> source = page.AfterId() is { } after
            ? db.WebhookEndpoints.FromSql($"SELECT * FROM webhook_endpoints WHERE id > {after}")
            : db.WebhookEndpoints;
        var rows = await source.AsNoTracking().OrderBy(e => e.Id).Take(page.Limit + 1).ToListAsync(ct);
        return Paging.Build(rows, page.Limit, e => e.Id.ToString(), WebhookEndpointView.From);
    }

    /// <summary>Returns the endpoint with its delivery counts and the time of its latest successful delivery.</summary>
    public async Task<WebhookEndpointDetailView> GetAsync(Guid id, CancellationToken ct)
    {
        var endpoint = await db.WebhookEndpoints.AsNoTracking().SingleOrDefaultAsync(e => e.Id == id, ct)
            ?? throw DomainException.NotFound("Webhook endpoint");
        var counts = await db.WebhookDeliveries.AsNoTracking()
            .Where(d => d.EndpointId == id)
            .GroupBy(d => d.Status)
            .Select(g => new { Status = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var lastDeliveredAt = await db.WebhookDeliveries.AsNoTracking()
            .Where(d => d.EndpointId == id && d.DeliveredAt != null)
            .MaxAsync(d => d.DeliveredAt, ct);

        int Count(WebhookDeliveryStatus status) => counts.SingleOrDefault(c => c.Status == status)?.Count ?? 0;

        return new WebhookEndpointDetailView(
            endpoint.Id,
            endpoint.Url,
            endpoint.EventTypes,
            endpoint.Status,
            endpoint.Secret,
            endpoint.PreviousSecretExpiresAt,
            endpoint.CreatedAt,
            new WebhookDeliveryCounts(
                Count(WebhookDeliveryStatus.Pending),
                Count(WebhookDeliveryStatus.Succeeded),
                Count(WebhookDeliveryStatus.Failed)),
            lastDeliveredAt);
    }

    public async Task<WebhookEndpointView> UpdateAsync(Guid id, WebhookEndpointChanges changes, CancellationToken ct)
    {
        var endpoint = await db.WebhookEndpoints.SingleOrDefaultAsync(e => e.Id == id, ct) ?? throw DomainException.NotFound("Webhook endpoint");
        if (changes.Url is not null)
        {
            EnsureUrlAllowed(changes.Url);
            endpoint.Url = changes.Url;
        }

        if (changes.EventTypes is not null)
        {
            endpoint.EventTypes = [.. changes.EventTypes.Distinct(StringComparer.Ordinal)];
        }

        endpoint.Status = changes.Status ?? endpoint.Status;
        await db.SaveChangesAsync(ct);
        return WebhookEndpointView.From(endpoint);
    }

    /// <summary>Issues a new secret; the old one keeps signing alongside it for 24 hours.</summary>
    public async Task<WebhookEndpointWithSecretView> RotateSecretAsync(Guid id, CancellationToken ct)
    {
        var endpoint = await db.WebhookEndpoints.SingleOrDefaultAsync(e => e.Id == id, ct) ?? throw DomainException.NotFound("Webhook endpoint");
        endpoint.PreviousSecret = endpoint.Secret;
        endpoint.PreviousSecretExpiresAt = clock.GetUtcNow() + RotationOverlap;
        endpoint.Secret = secrets.NewToken(SecretPrefix);
        await db.SaveChangesAsync(ct);
        return WebhookEndpointWithSecretView.From(endpoint);
    }

    private void EnsureUrlAllowed(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            throw DomainException.Validation("url", "Must be an absolute http(s) URL.");
        }

        if (uri.Scheme == Uri.UriSchemeHttp && !settings.WebhookAllowHttp)
        {
            throw DomainException.Validation("url", "Must use https.");
        }
    }
}
