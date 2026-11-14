using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Views;
using Billing.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Billing.Core.Services;

public sealed record NewSubscription(Guid CustomerId, string PlanCode, int Quantity, int? TrialDays);

/// <summary>Creates and reads subscriptions.</summary>
public sealed class SubscriptionService(
    BillingDbContext db,
    TimeProvider clock,
    SubscriptionCycle cycle,
    EventRecorder events,
    ViewLoader views,
    ILogger<SubscriptionService> logger)
{
    /// <summary>
    /// Subscribes the customer to the plan: in trial when trial days apply, otherwise active with period 0 opened
    /// and its first invoice finalised.
    /// </summary>
    public Task<SubscriptionView> CreateAsync(NewSubscription input, CancellationToken ct) =>
        db.InTransactionAsync(
            async () =>
            {
                var customer = await db.LockCustomerAsync(input.CustomerId, ct) ?? throw DomainException.NotFound("Customer");
                var plan = await db.PlanWithItemsAsync(input.PlanCode, ct) ?? throw DomainException.NotFound("Plan");
                if (!plan.Active)
                {
                    throw DomainException.Unprocessable(ErrorCodes.PlanIncompatible, "The plan is retired.");
                }

                if (plan.Currency != customer.Currency)
                {
                    throw DomainException.Unprocessable(ErrorCodes.PlanIncompatible, "The plan's currency differs from the customer's currency.");
                }

                var now = clock.GetUtcNow();
                var zone = BillingCalendar.FindZone(customer.Timezone);
                var today = BillingCalendar.Today(now, zone);
                var trialDays = input.TrialDays ?? plan.TrialDays;

                var subscription = new Subscription
                {
                    Id = Ids.New(clock),
                    CustomerId = customer.Id,
                    ProductId = plan.ProductId,
                    PlanId = plan.Id,
                    Quantity = input.Quantity,
                    CreatedAt = now,
                };

                SubscriptionPeriod? firstPeriod = null;
                if (trialDays > 0)
                {
                    var trialEndsOn = today.AddDays(trialDays);
                    subscription.Status = SubscriptionStatus.Trialing;
                    subscription.TrialEndsOn = trialEndsOn;
                    subscription.AnchorDate = trialEndsOn;
                    subscription.NextBillingAt = BillingCalendar.StartOfDay(trialEndsOn, zone);
                    db.Subscriptions.Add(subscription);
                }
                else
                {
                    subscription.Status = SubscriptionStatus.Active;
                    subscription.AnchorDate = today;
                    db.Subscriptions.Add(subscription);
                    firstPeriod = cycle.OpenPeriod(subscription, plan, 0, zone);
                }

                try
                {
                    await db.SaveChangesAsync(ct);
                }
                catch (DbUpdateException ex) when (ex.IsUniqueViolation("ux_subscriptions_live"))
                {
                    throw DomainException.Conflict(ErrorCodes.AlreadySubscribed, "The customer already has a live subscription to this product.");
                }

                logger.LogInformation(
                    "Subscription {SubscriptionId} created for customer {CustomerId} on plan {PlanCode} as {Status}",
                    subscription.Id,
                    customer.Id,
                    plan.Code,
                    subscription.Status);
                await events.SubscriptionAsync(EventTypes.SubscriptionCreated, subscription, null, ct);

                if (firstPeriod is not null)
                {
                    var invoice = cycle.NewInvoice(subscription, customer.Currency, InvoiceKind.Cycle, firstPeriod.PeriodStart, firstPeriod.PeriodEnd);
                    cycle.AddAdvanceLines(invoice, plan, subscription.Quantity, firstPeriod.PeriodStart, firstPeriod.PeriodEnd);
                    await cycle.SaveAndFinalizeAsync(invoice, ct);
                }

                return await views.SubscriptionAsync(subscription, ct);
            },
            ct);

    public async Task<SubscriptionView> GetAsync(Guid id, CancellationToken ct)
    {
        var subscription = await db.Subscriptions.AsNoTracking().SingleOrDefaultAsync(s => s.Id == id, ct)
            ?? throw DomainException.NotFound("Subscription");
        return await views.SubscriptionAsync(subscription, ct);
    }

    public async Task<Page<SubscriptionView>> ListAsync(Guid? customerId, PageRequest page, CancellationToken ct)
    {
        IQueryable<Subscription> source = page.AfterId() is { } after
            ? db.Subscriptions.FromSql($"SELECT * FROM subscriptions WHERE id > {after}")
            : db.Subscriptions;
        if (customerId is { } customer)
        {
            source = source.Where(s => s.CustomerId == customer);
        }

        var rows = await source.AsNoTracking().OrderBy(s => s.Id).Take(page.Limit + 1).ToListAsync(ct);
        var hasMore = rows.Count > page.Limit;
        var pageRows = rows.Take(page.Limit).ToList();
        var data = await views.SubscriptionsAsync(pageRows, ct);
        return new Page<SubscriptionView>(data, hasMore ? pageRows[^1].Id.ToString() : null);
    }
}
