namespace Billing.Core;

/// <summary>Per-scope information about the request or job run that is doing the work.</summary>
public sealed class RequestContext
{
    public string RequestId { get; set; } = Guid.NewGuid().ToString("N");

    public Guid? ApiKeyId { get; set; }
}
