using Billing.Core.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Billing.Worker;

public sealed class BillingRunLoop(IServiceScopeFactory scopes, TimeProvider clock, ILogger<BillingRunLoop> logger)
    : LoopService<BillingRun>(scopes, clock, logger)
{
    protected override TimeSpan Interval => TimeSpan.FromSeconds(60);
}

public sealed class PaymentLoop(IServiceScopeFactory scopes, TimeProvider clock, ILogger<PaymentLoop> logger)
    : LoopService<PaymentRun>(scopes, clock, logger)
{
    protected override TimeSpan Interval => TimeSpan.FromSeconds(30);
}

public sealed class RefundLoop(IServiceScopeFactory scopes, TimeProvider clock, ILogger<RefundLoop> logger)
    : LoopService<RefundRun>(scopes, clock, logger)
{
    protected override TimeSpan Interval => TimeSpan.FromSeconds(60);
}
