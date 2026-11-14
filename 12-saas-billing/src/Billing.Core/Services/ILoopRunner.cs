using Microsoft.Extensions.DependencyInjection;

namespace Billing.Core.Services;

/// <summary>One pass of a worker loop.</summary>
public interface ILoopRunner
{
    /// <summary>Processes the work that is due at <paramref name="now"/>.</summary>
    Task RunOnceAsync(DateTimeOffset now, CancellationToken ct);
}

public static class LoopScopes
{
    /// <summary>Creates a child scope that carries the request id of the current run.</summary>
    public static AsyncServiceScope CreateRunScope(this IServiceScopeFactory scopes, RequestContext parent)
    {
        var scope = scopes.CreateAsyncScope();
        scope.ServiceProvider.GetRequiredService<RequestContext>().RequestId = parent.RequestId;
        return scope;
    }
}
