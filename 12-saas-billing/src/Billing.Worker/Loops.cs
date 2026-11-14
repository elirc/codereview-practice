using Billing.Core.Services;
using Billing.Core.Webhooks;
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

public sealed class WebhookFanOutLoop(IServiceScopeFactory scopes, TimeProvider clock, ILogger<WebhookFanOutLoop> logger)
    : LoopService<WebhookFanOut>(scopes, clock, logger)
{
    protected override TimeSpan Interval => TimeSpan.FromSeconds(2);
}

public sealed class WebhookDeliveryLoop(IServiceScopeFactory scopes, TimeProvider clock, ILogger<WebhookDeliveryLoop> logger)
    : LoopService<WebhookDispatcher>(scopes, clock, logger)
{
    protected override TimeSpan Interval => TimeSpan.FromSeconds(2);
}

public sealed class PurgeLoop(IServiceScopeFactory scopes, TimeProvider clock, ILogger<PurgeLoop> logger)
    : LoopService<PurgeRun>(scopes, clock, logger)
{
    protected override TimeSpan Interval => TimeSpan.FromDays(1);
}
