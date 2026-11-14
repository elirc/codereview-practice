namespace Billing.Core.Data;

public sealed class WebhookEndpoint
{
    public Guid Id { get; set; }

    public string Url { get; set; } = string.Empty;

    public string Secret { get; set; } = string.Empty;

    public string? PreviousSecret { get; set; }

    public DateTimeOffset? PreviousSecretExpiresAt { get; set; }

    public string[] EventTypes { get; set; } = [];

    public WebhookEndpointStatus Status { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class WebhookEvent
{
    public Guid Id { get; set; }

    public long Sequence { get; set; }

    public string Type { get; set; } = string.Empty;

    public string ObjectType { get; set; } = string.Empty;

    public Guid ObjectId { get; set; }

    public string Body { get; set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset? FannedOutAt { get; set; }
}

public sealed class WebhookDelivery
{
    public Guid Id { get; set; }

    public Guid EventId { get; set; }

    public Guid EndpointId { get; set; }

    public Guid ObjectId { get; set; }

    public long Sequence { get; set; }

    public WebhookDeliveryStatus Status { get; set; }

    public int Attempts { get; set; }

    public DateTimeOffset NextAttemptAt { get; set; }

    public int? LastStatusCode { get; set; }

    public string? LastError { get; set; }

    public DateTimeOffset? DeliveredAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class ApiKey
{
    public Guid Id { get; set; }

    public string Name { get; set; } = string.Empty;

    public string KeyHash { get; set; } = string.Empty;

    public ApiRole Role { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset? RevokedAt { get; set; }
}

public sealed class IdempotencyRecord
{
    public Guid KeyId { get; set; }

    public string Key { get; set; } = string.Empty;

    public string RequestHash { get; set; } = string.Empty;

    public int ResponseStatus { get; set; }

    public string ResponseBody { get; set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; set; }
}
