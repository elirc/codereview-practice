using Billing.Core;
using Billing.Core.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Billing.Worker;

/// <summary>Runs one loop runner on a fixed interval, each pass in its own scope and logging scope.</summary>
public abstract class LoopService<TRunner>(IServiceScopeFactory scopes, TimeProvider clock, ILogger logger) : BackgroundService
    where TRunner : ILoopRunner
{
    protected abstract TimeSpan Interval { get; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval, clock);
        do
        {
            var runId = Guid.NewGuid().ToString("N");
            using (logger.BeginScope(new Dictionary<string, object> { ["Loop"] = typeof(TRunner).Name, ["JobRunId"] = runId }))
            {
                try
                {
                    await using var scope = scopes.CreateAsyncScope();
                    scope.ServiceProvider.GetRequiredService<RequestContext>().RequestId = runId;
                    var runner = scope.ServiceProvider.GetRequiredService<TRunner>();
                    await runner.RunOnceAsync(clock.GetUtcNow(), stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Loop run {JobRunId} failed", runId);
                }
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
