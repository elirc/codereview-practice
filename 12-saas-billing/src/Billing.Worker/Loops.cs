using Billing.Core.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Billing.Worker;

public sealed class BillingRunLoop(IServiceScopeFactory scopes, TimeProvider clock, ILogger<BillingRunLoop> logger)
    : LoopService<BillingRun>(scopes, clock, logger)
{
    protected override TimeSpan Interval => TimeSpan.FromSeconds(60);
}
