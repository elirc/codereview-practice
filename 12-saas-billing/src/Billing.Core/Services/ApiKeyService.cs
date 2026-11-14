using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Views;
using Microsoft.EntityFrameworkCore;

namespace Billing.Core.Services;

/// <summary>Creates, revokes and resolves API keys.</summary>
public sealed class ApiKeyService(BillingDbContext db, TimeProvider clock, ISecretGenerator secrets)
{
    public const string KeyPrefix = "bk_";

    /// <summary>Creates a key and returns it with its plain value, which is not stored.</summary>
    public async Task<ApiKeyCreatedView> CreateAsync(string name, ApiRole role, CancellationToken ct)
    {
        var plain = secrets.NewToken(KeyPrefix);
        var key = new ApiKey
        {
            Id = Ids.New(clock),
            Name = name,
            KeyHash = Hashing.Sha256Hex(plain),
            Role = role,
            CreatedAt = clock.GetUtcNow(),
        };
        db.ApiKeys.Add(key);
        await db.SaveChangesAsync(ct);
        return new ApiKeyCreatedView(key.Id, key.Name, key.Role, plain, key.CreatedAt);
    }

    /// <summary>Revokes a key; revoking an already revoked key leaves it unchanged.</summary>
    public async Task<ApiKeyView> RevokeAsync(Guid id, CancellationToken ct)
    {
        var key = await db.ApiKeys.SingleOrDefaultAsync(k => k.Id == id, ct)
            ?? throw DomainException.NotFound("API key");
        key.RevokedAt ??= clock.GetUtcNow();
        await db.SaveChangesAsync(ct);
        return ApiKeyView.From(key);
    }

    /// <summary>Returns the active key matching the presented value, or null.</summary>
    public Task<ApiKey?> FindActiveAsync(string presented, CancellationToken ct)
    {
        var hash = Hashing.Sha256Hex(presented);
        return db.ApiKeys.AsNoTracking().SingleOrDefaultAsync(k => k.KeyHash == hash && k.RevokedAt == null, ct);
    }
}
