# 12 — SaaS Billing

## 1. Purpose

A subscription billing platform for one software business. It holds customers, a catalogue of plans with flat, per-seat and tiered usage prices, and subscriptions with trials and mid-cycle changes. A worker turns each billing period into exactly one invoice, rates metered usage, applies tax and customer credit, collects payment through a gateway with a dunning schedule, and delivers signed webhooks about everything that happens. API only; there is no UI. Read `../CONVENTIONS.md` first, including section 12.

Conventions pointer: doc comments and comments say what a function does and returns. They never name the duplicate, race, double charge or late event a piece of code is there for, and never describe the locking, claiming, deduplication or ordering design (CONVENTIONS §4 and §12.1).

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Runtime | .NET 10 (`net10.0`, SDK 10.0.100 pinned in `global.json` with `rollForward: latestFeature`), C# with nullable reference types and `TreatWarningsAsErrors` |
| Solution | `Billing.slnx`; central package versions in `Directory.Packages.props`; shared settings in `Directory.Build.props` |
| Web | ASP.NET Core minimal APIs (`Microsoft.NET.Sdk.Web`), route groups per resource, `System.Text.Json` web defaults plus `JsonUnmappedMemberHandling.Disallow` and `JsonNumberHandling.Strict` |
| DB | PostgreSQL 16 (compose host port 5464). `Microsoft.EntityFrameworkCore` 10.0.0, `Microsoft.EntityFrameworkCore.Relational` 10.0.0, `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.0. Enums stored as strings. Table and column names are `snake_case`, set by a loop over the model in `OnModelCreating` (no naming-convention package). Row locks and claims use `FromSql` with interpolated parameters (`… FOR UPDATE`, `… FOR UPDATE SKIP LOCKED`) |
| Migrations | Hand-written EF Core migration classes in `src/Billing.Core/Migrations` (`[DbContext]` and `[Migration("<timestamp>_<Name>")]` attributes on the class, `Up`/`Down` with `MigrationBuilder`; `migrationBuilder.Sql` for triggers, check constraints, partial indexes and the exclusion constraint) plus a hand-written `BillingDbContextModelSnapshot.cs` consistent with the model. Applied only by `dotnet run --project src/Billing.Api -- migrate`; never at start-up |
| Worker | `Microsoft.Extensions.Hosting` 10.0.0 generic host with one `BackgroundService` per loop; `Microsoft.Extensions.Http` 10.0.0 for the webhook `HttpClient` |
| Time | `TimeProvider` injected everywhere; `DateOnly` for civil dates; `DateTimeOffset` (always UTC, offset zero) for instants; `TimeZoneInfo.FindSystemTimeZoneById` with IANA ids. No `DateTime.Now`/`UtcNow`, no NodaTime |
| Logging | `Microsoft.Extensions.Logging` with `AddJsonConsole`; request id middleware and a logging scope per job run |
| Tests | `xunit` 2.9.2, `xunit.runner.visualstudio` 2.8.2, `Microsoft.NET.Test.Sdk` 17.12.0, `Microsoft.AspNetCore.Mvc.Testing` 10.0.0. Integration tests use a real Postgres from `TEST_DATABASE_URL` (CI service container), a `ManualTimeProvider : TimeProvider` written in the test project, a scripted `FakeGateway` and a recording `HttpMessageHandler` |
| Format | `dotnet format --verify-no-changes` with a committed `.editorconfig` |
| Auth | API keys (CONVENTIONS §12.8) resolved by a small middleware into a `Caller` (key id, role); endpoint groups declare the roles allowed through one `RequireRole` filter. No ASP.NET Identity |

Projects: `src/Billing.Domain` (pure, no package references: money, calendar, proration, tier rating, tax, dunning schedule, webhook signature), `src/Billing.Core` (EF model and configurations, migrations, application services, gateway and webhook abstractions and their implementations), `src/Billing.Api` (endpoints, validation, error handling, `migrate` and `seed` commands), `src/Billing.Worker` (loops), `tests/Billing.Domain.Tests`, `tests/Billing.IntegrationTests`. API port 8120.

Validation: each request DTO has a hand-written validator (`IValidator<T>` defined in the project) run by an endpoint filter before the handler; no validation package.

Money is `long` minor units with the customer's ISO-4217 currency (2-decimal currencies only: `USD`, `EUR`, `GBP`). A plan's currency must equal the customer's. No `double`, `float` or `decimal` in a money path; rates are basis points.

## 3. Roles and permissions

| Action | service | support | billing_ops | admin |
|---|---|---|---|---|
| Create/update customers; set payment method | yes | no | yes | yes |
| Read customers, subscriptions, invoices, credit notes, usage summaries | yes | yes | yes | yes |
| Create, change, cancel, resume subscriptions | yes | no | yes | yes |
| Ingest usage events | yes | no | no | no |
| Create and edit draft manual invoices; finalise; void; retry payment | no | no | yes | yes |
| Issue credit notes; adjust customer credit balance | no | no | yes | yes |
| Manage products, plans, meters, tax rates | no | no | no | yes |
| Manage webhook endpoints; read and retry deliveries | no | no | yes (read, retry) | yes |
| Manage API keys | no | no | no | yes |

`401 unauthenticated` without a valid key; `403 forbidden` for a role outside the row. There is no per-customer scoping: every key acts for the one business.

## 4. Domain model

- **Customer**: `id`, `externalId` (unique), `name`, `email`, `currency`, `timezone` (IANA, validated), `country` (ISO alpha-2), `region?`, `taxExempt`, `paymentMethodToken?`, `creditBalanceMinor` (>= 0), `createdAt`.
- **Product**: `id`, `name`, `active`. **Plan**: `id`, `productId`, `code` (unique), `name`, `interval` (`month` | `year`), `currency`, `trialDays` (0–90), `active`. A plan and its items cannot be edited once a subscription references it; retire it with `active = false` and create a new plan.
- **PlanItem**: `id`, `planId`, `kind` (`flat` | `per_seat` | `usage`), `name`, `unitAmountMinor` (flat and per-seat), `meterCode?` and `tierMode?` (`graduated` | `volume`) for usage. A plan has at most one `per_seat` item and at most one `usage` item per meter. **PriceTier**: `planItemId`, `position`, `upTo?` (inclusive upper bound; null only on the last tier), `unitAmountMinor`, `flatAmountMinor`; `upTo` strictly increasing.
- **Meter**: `code` (unique), `name`, `aggregation` (`sum` | `max`).
- **Subscription**: `id`, `customerId`, `productId`, `planId`, `status` (`trialing` | `active` | `past_due` | `canceled`), `quantity` (>= 1), `anchorDate`, `periodIndex`, `currentPeriodStart`, `currentPeriodEnd` (dates; null while trialing), `trialEndsOn?`, `nextBillingAt?` (instant), `pendingPlanId?`, `pendingQuantity?`, `cancelAtPeriodEnd`, `canceledAt?`, `cancelReason?` (`requested` | `dunning_exhausted`), `endedOn?`, `finalSealedAt?`, `createdAt`. Partial unique index `(customerId, productId) WHERE status <> 'canceled'`.
- **SubscriptionPeriod**: `id`, `subscriptionId`, `index`, `periodStart`, `periodEnd`, `planId` (the plan whose usage prices rate this period), `usageSealedAt?`; unique `(subscriptionId, index)`.
- **UsageEvent**: `id`, `subscriptionId`, `meterCode`, `eventKey`, `quantity` (> 0), `occurredAt`, `receivedAt`, `billedPeriodId?`, `late`; unique `(subscriptionId, eventKey)`.
- **Invoice**: `id`, `number?` (unique), `customerId`, `subscriptionId?`, `kind` (`cycle` | `proration` | `final` | `manual`), `periodStart?`, `periodEnd?`, `status` (`draft` | `open` | `paid` | `void` | `uncollectible`), `currency`, `subtotalMinor`, `taxMinor`, `totalMinor`, `creditAppliedMinor`, `amountDueMinor`, `amountPaidMinor`, `creditedMinor`, `refundedMinor`, `amountRemainingMinor`, `issueDate?`, `finalizedAt?`, `paidAt?`, customer snapshot (`billToName`, `billToEmail`, `billToCountry`, `billToRegion`, `billToTaxExempt`), `declineCount`, `attemptCount`, `nextPaymentAttemptAt?`. Partial unique indexes: `(subscriptionId, periodStart) WHERE kind = 'cycle'` and `(subscriptionId) WHERE kind = 'final'`.
- **InvoiceLine**: `id`, `invoiceId`, `lineNo`, `kind` (`flat` | `seats` | `usage` | `proration_credit` | `proration_charge` | `manual`), `description`, `planItemId?`, `quantity`, `amountMinor` (signed), `taxRateBps`, `taxMinor`, `periodStart?`, `periodEnd?`, `creditedMinor`, `creditedTaxMinor`.
- **TaxRate**: `id`, `country`, `region?`, `rateBps` (0–5000), `validFrom` (date), `validTo?` (exclusive). An exclusion constraint (`btree_gist`) forbids overlapping ranges for the same `(country, coalesce(region, ''))`.
- **PaymentAttempt**: `id`, `invoiceId`, `attemptNo`, `idempotencyKey` (`<invoiceId>:<attemptNo>`, unique), `amountMinor`, `status` (`pending` | `succeeded` | `failed` | `unknown`), `gatewayChargeId?`, `failureCode?`, `countsAsDecline`, `createdAt`, `completedAt?`; unique `(invoiceId, attemptNo)`.
- **CreditNote**: `id`, `number` (unique), `invoiceId`, `reason`, `disposition` (`reduce_due` | `refund` | `credit_balance`), `subtotalMinor`, `taxMinor`, `totalMinor`, `refundStatus?` (`pending` | `succeeded` | `failed`), `createdByKeyId`, `createdAt`. **CreditNoteLine**: `creditNoteId`, `invoiceLineId`, `amountMinor`, `taxMinor`.
- **CreditBalanceTransaction**: `id`, `customerId`, `amountMinor` (signed), `kind` (`credit_note` | `applied_to_invoice` | `void_reversal` | `manual_adjustment`), `invoiceId?`, `creditNoteId?`, `balanceAfterMinor`, `createdAt`. The customer balance always equals the sum of its transactions.
- **Counter**: `name` (`invoice` | `credit_note`), `year`, `next`; primary key `(name, year)`.
- **WebhookEndpoint**: `id`, `url`, `secret`, `previousSecret?`, `previousSecretExpiresAt?`, `eventTypes` (text array; `*` for all), `status` (`enabled` | `disabled`), `createdAt`. **WebhookEvent**: `id`, `sequence` (bigint identity), `type`, `objectType`, `objectId`, `body` (text, the serialised envelope), `createdAt`, `fannedOutAt?`. **WebhookDelivery**: `id`, `eventId`, `endpointId`, `objectId`, `sequence`, `status` (`pending` | `succeeded` | `failed`), `attempts`, `nextAttemptAt`, `lastStatusCode?`, `lastError?`, `deliveredAt?`; unique `(eventId, endpointId)`.
- **IdempotencyRecord**: `keyId`, `key`, `requestHash`, `responseStatus`, `responseBody`, `createdAt`; unique `(keyId, key)`. **ApiKey**: `id`, `name`, `keyHash`, `role`, `revokedAt?`.

Database invariants (in migrations): the indexes above; a trigger on `invoices` that rejects, for rows whose stored status is not `draft`, any update that changes a column other than `status`, `amount_paid_minor`, `credited_minor`, `refunded_minor`, `amount_remaining_minor`, `paid_at`, `decline_count`, `attempt_count`, `next_payment_attempt_at`, and any delete; a trigger on `invoice_lines` that rejects insert, delete, and any update other than to `credited_minor`/`credited_tax_minor`, when the parent invoice is not `draft`; checks `amount_remaining_minor >= 0`, `credited_minor <= amount_minor` on positive lines.

## 5. Domain rules

### 5.1 Calendar

- A customer's "today" is the civil date in `customer.timezone` at `now`. All period boundaries are civil dates in that zone; a period is `[periodStart, periodEnd)`.
- `startOfDay(date, zone)` is the instant of local midnight. If local midnight does not exist that day (a zone whose clocks jump at midnight, such as `America/Santiago`), it is the first valid instant of the day; if it occurs twice, the earlier.
- `addMonthsClamped(anchor, k)`: move `k` months from the anchor's year and month and use `min(anchor.day, daysInMonth)`. Period `i` of a monthly subscription is `[addMonthsClamped(anchor, i), addMonthsClamped(anchor, i + 1))`; yearly uses `12 × i`. Boundaries are always computed from `anchorDate` and the index, never from the previous boundary.
- Day counts for proration are civil days: `D = periodEnd − periodStart`, `R = periodEnd − today`.

### 5.2 Subscribing and trials

`POST /subscriptions` `{ customerId, planCode, quantity?, trialDays? }` (override 0–90). The plan must be active and in the customer's currency (`422 plan_incompatible`). A second live subscription to the same product is `409 already_subscribed` (the unique index decides under concurrency).

- With a trial: status `trialing`, `trialEndsOn = today + trialDays`, `anchorDate = trialEndsOn`, `nextBillingAt = startOfDay(trialEndsOn)`. No invoice.
- Without: status `active`, `anchorDate = today`, period 0 created, and the first cycle invoice (advance lines only) created and finalised in the same transaction.

### 5.3 Billing run

The run claims subscriptions with `status <> 'canceled'` and `next_billing_at <= now` (`FOR UPDATE SKIP LOCKED`, batch 50) and processes each in its own transaction, holding the subscription row lock throughout. One pass handles one boundary per subscription; a subscription that is several periods behind is picked up again on later passes until it is current.

- **Trial end**: status `active`, period 0 created, cycle invoice for period 0 with advance lines; emits `subscription.trial_ended`.
- **Period boundary** for period `k`, due at `startOfDay(periodEnd(k)) + USAGE_GRACE_MINUTES` (default 60):
  1. Seal usage: mark every unbilled event of the subscription with `occurredAt < startOfDay(periodEnd(k))` as billed in period `k` (`late = true` when `occurredAt < startOfDay(periodStart(k))`), set `usageSealedAt`.
  2. Rate the sealed usage per meter with the usage items of the period's `planId` (5.5).
  3. If `cancelAtPeriodEnd`: status `canceled`, `endedOn = periodEnd(k)`, `finalSealedAt = now`; create a `final` invoice holding only the usage lines, or no invoice when there are none. Stop.
  4. Otherwise apply `pendingPlanId`/`pendingQuantity`, create period `k + 1` (its `planId` is the plan now in effect), and create the cycle invoice for `periodStart(k + 1)`: usage lines for period `k` first, then advance lines (`flat`: amount; `seats`: `unitAmountMinor × quantity`) for period `k + 1`. Advance `periodIndex`, the current period dates and `nextBillingAt`.
- The invoice is finalised (5.6) in the same transaction. A unique-index violation on the cycle or final invoice means the boundary was already billed: the transaction rolls back and the subscription is re-read.
- `past_due` subscriptions keep being billed.

### 5.4 Usage ingestion

`POST /usage-events` `{ events: [{ eventKey (1–100), subscriptionId, meterCode, quantity, occurredAt }] }`, 1–500 events. The response is `200` with one result per event in request order: `accepted`, `duplicate`, or `rejected` with a `reason`. A malformed batch (schema) is a `400` and stores nothing; per-event outcomes never fail the batch.

Subscriptions named in the batch are locked `FOR SHARE` in id order, then per event:

- unknown subscription or meter, or the meter is not sold by any plan of the product → `rejected: unknown_subscription` / `unknown_meter`;
- `occurredAt > now + 5 min` → `in_future`; `occurredAt < now − USAGE_MAX_AGE_DAYS` (35) → `too_old`;
- `occurredAt` before the start of period 0 (including the whole trial) → `before_billing_start`;
- subscription `canceled` with `finalSealedAt` set, or `occurredAt >= startOfDay(endedOn)` → `subscription_ended`;
- an existing row with the same `(subscriptionId, eventKey)`: `duplicate` when `meterCode`, `quantity` and `occurredAt` are identical, otherwise `rejected: key_conflict`. Two events with the same key inside one batch follow the same rule against each other;
- otherwise insert, `accepted`.

An event is billed in the first sealing whose period end is after its `occurredAt`, so an event that arrives after its own period was sealed is billed with the next period and marked `late`. An event is never billed twice and never moved once billed.

### 5.5 Rating usage

Per meter and sealing: `sum` adds the quantities; `max` takes the largest single quantity. Zero usage produces no line.

- `graduated`: units are spread over the tiers in order; each tier reached contributes `unitsInTier × unitAmountMinor + flatAmountMinor`.
- `volume`: the tier containing the total prices all units: `total × unitAmountMinor + flatAmountMinor`.
- A total equal to a tier's `upTo` belongs to that tier.

### 5.6 Finalisation

`draft → open`, in one transaction, in this lock order: subscription (if any), invoice, customer, counter.

1. Snapshot the customer's billing fields. `issueDate` = customer's today.
2. Tax per line (5.7); `subtotal = Σ amountMinor`; `tax = Σ taxMinor`; `total = subtotal + tax`. An invoice with no lines or a negative total cannot be finalised (`422 invoice_not_finalizable`).
3. Apply credit: `creditApplied = min(customer.creditBalanceMinor, total)`; write an `applied_to_invoice` transaction; `amountDue = amountRemaining = total − creditApplied`.
4. Number: lock the counter row for (`invoice`, year of `issueDate`), take `next`, format `INV-<year>-<6 digits>`. Numbers are gapless per year: a rolled-back finalisation consumes none.
5. If `amountRemaining = 0`: status `paid`, `paidAt = now`. Otherwise `open` with `nextPaymentAttemptAt = now`.
6. Events: `invoice.finalized`, and `invoice.paid` when paid at once.

After finalisation the invoice's lines, amounts, number, dates and snapshot never change; only the payment and credit columns listed in section 4 do.

Manual invoices (`kind = manual`) are created as drafts with positive lines, edited while draft, and finalised by `POST /invoices/{id}/finalize`. Subscription invoices are never left in `draft`.

**Void**: `open` only, and only when no attempt is `pending` or `unknown` (`409 payment_in_progress`). Status `void`, `amountRemaining = 0`, applied credit returned to the customer with a `void_reversal` transaction, `invoice.voided` emitted. A `paid` invoice is corrected with a credit note.

### 5.7 Tax

Rate for an invoice: the `TaxRate` for (`billToCountry`, `billToRegion`) valid on `issueDate` (`validFrom <= issueDate < validTo`); if none, the rate for the country with `region` null; if none, 0. `billToTaxExempt` → 0. `taxMinor = roundHalfAwayFromZero(amountMinor × rateBps / 10000)` per line, in integer arithmetic; the invoice tax is the sum of line taxes and is never recomputed from the subtotal.

### 5.8 Plan and quantity changes

`POST /subscriptions/{id}/change` `{ planCode?, quantity? }` (at least one), `Idempotency-Key` required. The new plan must belong to the same product and have the same interval and currency (`422 plan_incompatible`). Refused when `canceled` or `cancelAtPeriodEnd` (`409 invalid_state`), and when the customer's today is on or after `currentPeriodEnd` (`409 renewal_in_progress`).

Let `recurring(plan, qty) = Σ flat amounts + per-seat unit × qty`.

- **Trialing**: plan and quantity change at once; nothing is invoiced.
- **Increase** (`recurring(new) > recurring(old)`): effective now. A `proration` invoice for `[today, currentPeriodEnd)`: for every advance item of the old configuration a `proration_credit` line of `−roundHalfUp(amount × R / D)`, and for every advance item of the new one a `proration_charge` line of `+roundHalfUp(amount × R / D)`; each line rounded on its own. Any meter the old plan sold and the new plan does not: its unbilled usage with `occurredAt < now` is sealed into the current period, rated with the old tiers and added as `usage` lines. The invoice is finalised in the same transaction; the subscription's plan and quantity, and the current period's `planId`, change regardless of whether the invoice is later paid. Pending changes are cleared.
- **Decrease** (`recurring(new) < recurring(old)`): stored as `pendingPlanId`/`pendingQuantity`, replacing any earlier pending change, applied at the next boundary. No credit.
- **Equal**: effective now, no invoice.
- A change made on the first day of a period has `R = D`; on the last day `R = 1`.

### 5.9 Cancellation

`POST /subscriptions/{id}/cancel` `{ mode }`:

- `period_end`: sets `cancelAtPeriodEnd`; `POST …/resume` clears it while the subscription is not yet canceled. The boundary run finishes it (5.3 step 3).
- `immediate`: status `canceled`, `canceledAt = now`, `endedOn` = customer's today, `finalSealedAt = now`. Unbilled usage with `occurredAt < now` is sealed into the current period and rated; if it produces lines, a `final` invoice is created and finalised. Advance charges already invoiced are not refunded automatically.
- `trialing`: canceled with no invoice.
- A canceled subscription's open invoices remain collectible: payment attempts, dunning, credit notes and webhooks continue for them.

Emits `subscription.canceled`. Cancelling a canceled subscription is `409 invalid_state`.

### 5.10 Payments and dunning

`IPaymentGateway`: `Charge(token, amountMinor, currency, idempotencyKey)` → `Succeeded(chargeId)` | `Declined(code)` or throws `GatewayTimeoutException`; `Lookup(idempotencyKey)` → `Succeeded(chargeId)` | `Declined(code)` | `NotFound`; `Refund(chargeId, amountMinor, idempotencyKey)`. `FakeGateway` is scripted by token (`tok_ok`, `tok_decline_<code>`, `tok_timeout_then_ok`, …).

The payment loop claims `open` invoices with `next_payment_attempt_at <= now` (`SKIP LOCKED`, batch 20). Per invoice:

1. Transaction A (invoice locked, status re-checked): if the latest attempt is `pending` or `unknown`, go to step 3 with it. If the customer has no payment method: record a `failed` attempt with code `no_payment_method`, `countsAsDecline = true`, apply the decline rules, done. Otherwise insert attempt `attemptNo = attemptCount + 1` (`pending`, amount = `amountRemaining`), increment `attemptCount`, set `nextPaymentAttemptAt = now + 15 min`, commit.
2. Call `Charge` outside any transaction.
3. For a `pending`/`unknown` attempt from an earlier pass, call `Lookup` instead of `Charge`.
4. Transaction B (invoice locked): 
   - success → attempt `succeeded`; `amountPaid += amount`, `amountRemaining = 0`, status `paid`, `paidAt`; emit `invoice.paid`; subscription rule below.
   - declined → attempt `failed`, `countsAsDecline = true`; `declineCount + 1`; then by `declineCount`: 1 → next attempt in 3 days, 2 → 5 days, 3 → 7 days, 4 → invoice `uncollectible`, `nextPaymentAttemptAt = null`, and the subscription (if any, and not already canceled) is canceled as in 5.9 `immediate` with reason `dunning_exhausted`. Emit `invoice.payment_failed` (with `nextPaymentAttemptAt`) or `invoice.marked_uncollectible`.
   - timeout → attempt `unknown`; `nextPaymentAttemptAt = now + 15 min`.
   - `Lookup` → `NotFound`: attempt `failed`, code `not_processed`, `countsAsDecline = false`; `nextPaymentAttemptAt = now`.
- At most one attempt per invoice is `pending` or `unknown` at any time, and a new charge is never sent while one is.
- Subscription status: the first counted decline on any of its invoices makes an `active` subscription `past_due`; when an invoice is paid and the subscription has no other `open` invoice with `declineCount > 0`, a `past_due` subscription becomes `active`. `canceled` never changes.
- `POST /invoices/{id}/pay` (ops) sets `nextPaymentAttemptAt = now` on an `open` invoice with no attempt in progress; it does not reset `declineCount`.

### 5.11 Credit notes and customer credit

`POST /invoices/{id}/credit-notes` `{ lines: [{ invoiceLineId, amountMinor }], reason (1–200), disposition }`, `Idempotency-Key` required. Under the invoice row lock, then the customer row:

- Invoice must be `open` or `paid` (`409 invalid_state`); no attempt may be `pending` or `unknown` (`409 payment_in_progress`).
- Each line must belong to the invoice and have a positive `amountMinor`; credit `<= line.amountMinor − line.creditedMinor` (`422 exceeds_creditable`). A line may appear once per note.
- Line tax: `roundHalfAwayFromZero(amount × line.taxRateBps / 10000)`, except that a credit taking the line's whole remaining amount takes the line's whole remaining tax (`line.taxMinor − line.creditedTaxMinor`). `total = Σ amount + Σ tax`.
- `open` invoice: disposition must be `reduce_due`; `total <= amountRemaining` (`422 exceeds_remaining`); `amountRemaining −= total`; at zero the invoice becomes `paid` and `invoice.paid` is emitted.
- `paid` invoice: `credit_balance` adds `total` to the customer's balance with a `credit_note` transaction; `refund` requires `total <= amountPaid − refundedMinor` (`422 exceeds_refundable`), creates the note with `refundStatus = pending` and increases `refundedMinor`. The refund loop calls `Refund` with the credit note id as idempotency key against the invoice's succeeded charge; success → `succeeded`; a gateway error → retried on later passes up to 5 times, then `failed` and `refundedMinor` is reduced again.
- Numbers come from the `credit_note` counter (`CN-<year>-<6 digits>`). Credit notes are immutable.
- `POST /customers/{id}/credit-adjustments` `{ amountMinor (signed, non-zero), reason }` writes a `manual_adjustment`; the balance may not go below zero (`422 insufficient_credit`).

### 5.12 Webhooks

- Every event below is written to `webhook_events` in the transaction of the change it reports. `body` is the envelope of CONVENTIONS §12.4 (`camelCase`), serialised once; `sequence` is the row's identity value; `data.object` is the API representation of the object at that moment.
- **Fan-out loop**: events with `fannedOutAt` null, in `sequence` order, one transaction each: insert a `pending` delivery (`nextAttemptAt = now`) for every `enabled` endpoint whose `eventTypes` contains the type or `*`; set `fannedOutAt`. Endpoints created later do not receive earlier events.
- **Delivery loop**: claims `pending` deliveries with `next_attempt_at <= now` for which no delivery to the same endpoint for the same `objectId` with a lower `sequence` is still `pending` (`SKIP LOCKED`, batch 50). Claiming sets `nextAttemptAt = now + 5 min` and commits; then the request is sent; then the outcome is stored in a second transaction.
- Request: `POST` the stored `body` bytes unchanged, `Content-Type: application/json`, 10 s timeout, no redirects. Headers: `Billing-Event-Id`, `Billing-Event-Type`, `Billing-Delivery-Attempt`, and `Billing-Signature: t=<unix seconds>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>." + body)`. While `previousSecretExpiresAt > now` a second `v1` computed with `previousSecret` is appended. `t` comes from the injected clock at send time.
- Outcome: `2xx` → `succeeded`. `410` → delivery `failed`, endpoint `disabled`, its other `pending` deliveries `failed`. Anything else (other status, timeout, connection error) → `attempts + 1`; next attempt after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h; the eighth failure makes the delivery `failed`.
- A `failed` delivery no longer holds back later events for the same object. `POST /webhook-deliveries/{id}/retry` puts a `failed` delivery back to `pending` with `attempts = 0`.
- Secrets are generated by the server (32 random bytes, `whsec_` + base64url), returned only on create and rotate. Rotation keeps the old secret valid for 24 h. URLs must be `https` unless `WEBHOOK_ALLOW_HTTP=true`.

### 5.13 Request idempotency

`Idempotency-Key` (8–128 chars) is required on `POST /subscriptions`, `/subscriptions/{id}/change`, `/subscriptions/{id}/cancel`, `/invoices/{id}/credit-notes` and `/customers/{id}/credit-adjustments` (`400 idempotency_key_required`). The record is inserted first in the operation's transaction; same key and same request hash (SHA-256 of method, path and canonical body) replays the stored response; a different hash is `422 idempotency_key_reused`. `2xx` and business `4xx` (`409`, `422`) responses are stored; `5xx` stores nothing.

## 6. API and event surface

Prefix `/v1`, `camelCase` JSON, cursor pagination (`?after=&limit=`, default 50, max 200).

| Method & path | Notes |
|---|---|
| `POST/GET /customers`, `GET/PATCH /customers/{id}` | Changing `timezone` is refused while a live subscription exists (`409 invalid_state`) |
| `PUT /customers/{id}/payment-method` | `{ token }` |
| `GET /customers/{id}/credit-transactions`, `POST /customers/{id}/credit-adjustments` | 5.11 |
| `POST/GET /products`, `POST/GET /plans`, `GET /plans/{code}`, `POST /plans/{code}/retire` | Plan create takes items and tiers in one body |
| `POST/GET /meters`, `POST/GET /tax-rates` | Overlapping tax range → `422 tax_rate_overlap` |
| `POST /subscriptions`, `GET /subscriptions/{id}`, `GET /subscriptions?customerId=` | 5.2 |
| `POST /subscriptions/{id}/change`, `/cancel`, `/resume` | 5.8, 5.9 |
| `POST /usage-events` | 5.4 |
| `GET /subscriptions/{id}/usage?periodIndex=` | per meter: billed and unbilled totals |
| `POST /invoices` (manual draft), `PUT /invoices/{id}/lines`, `POST /invoices/{id}/finalize`, `/void`, `/pay` | 5.6, 5.10 |
| `GET /invoices/{id}`, `GET /invoices?customerId=&status=` | with lines, attempts and credit notes |
| `POST /invoices/{id}/credit-notes`, `GET /credit-notes/{id}` | 5.11 |
| `POST/GET /webhook-endpoints`, `PATCH /webhook-endpoints/{id}`, `POST /webhook-endpoints/{id}/rotate-secret` | 5.12 |
| `GET /webhook-deliveries?endpointId=&status=`, `POST /webhook-deliveries/{id}/retry` | |
| `POST /api-keys`, `DELETE /api-keys/{id}` | |

Error codes beyond those named above: `validation_failed`, `unauthenticated`, `forbidden`, `not_found`, `invalid_state`, `internal_error`.

Webhook event types (`objectType` in brackets; `data` is `{ "object": … }` plus the extra fields shown):

| Type | Emitted when | Extra `data` |
|---|---|---|
| `subscription.created` [subscription] | 5.2 | |
| `subscription.trial_ended` [subscription] | trial boundary billed | |
| `subscription.updated` [subscription] | plan/quantity change applied or scheduled, status change, resume, `cancelAtPeriodEnd` set | `previous: { planCode, quantity, status }` |
| `subscription.canceled` [subscription] | 5.9, 5.3 step 3, dunning | `reason` |
| `invoice.finalized`, `invoice.paid`, `invoice.voided`, `invoice.marked_uncollectible` [invoice] | 5.6, 5.10, 5.11 | |
| `invoice.payment_failed` [invoice] | counted decline | `failureCode`, `nextPaymentAttemptAt?` |
| `credit_note.created`, `credit_note.refund_failed` [credit_note] | 5.11 | |

## 7. Worker loops

Each loop is a `BackgroundService` that calls a `RunOnceAsync(now)` on a scoped service; tests call that method directly. All loops are safe with several workers.

| Loop | Interval | Behaviour and failure semantics |
|---|---|---|
| Billing run | 60 s | 5.3. One subscription's failure rolls back its transaction, is logged with the subscription id, and does not stop the batch; it is retried on the next pass |
| Payment loop | 30 s | 5.10. A crash between transactions A and B leaves a `pending` attempt that the next pass resolves with `Lookup` |
| Refund loop | 60 s | 5.11; `pending` refunds, `SKIP LOCKED` |
| Webhook fan-out | 2 s | 5.12 |
| Webhook delivery | 2 s | 5.12. A crash after sending and before storing the outcome leads to a second delivery of the same event id after the claim lapses |
| Purge | daily | Idempotency records older than 7 days; `succeeded` deliveries older than 30 days |

## 8. Edge cases

1. Monthly subscription anchored on 31 January: periods start 31 Jan, 28 Feb (29 in a leap year), 31 Mar, 30 Apr.
2. Yearly subscription anchored on 29 February 2028: next boundaries 28 Feb 2029, 2030, 2031, then 29 Feb 2032.
3. A customer in `Pacific/Auckland`: the boundary falls at local midnight, which is the previous day in UTC; a usage event at 23:59:59 local belongs to the old period and one at 00:00:00 to the new.
4. A boundary on a date whose local midnight does not exist uses the first valid instant of that day.
5. A period containing a DST change still has `D` equal to its number of civil days.
6. "Today" for a change request at 02:00 UTC for a customer in `America/Los_Angeles` is the previous civil date.
7. Two workers running the billing run at once produce one cycle invoice per subscription and period.
8. A worker that was down for three months bills three periods, one invoice each, with the correct period dates, over successive passes.
9. The billing run before `periodEnd + grace` does nothing; at exactly that instant it bills.
10. An event arriving during the grace window with `occurredAt` in the ended period is on that period's invoice.
11. An event arriving after sealing with `occurredAt` in the sealed period is billed with the next period and marked `late`; it is never added to the finalised invoice.
12. The same `eventKey` sent twice (same batch, separate batches, concurrently) is stored once; the same key with a different quantity is rejected and the original is unchanged.
13. A batch where some events are rejected still stores the others; results are in request order.
14. Events more than 5 minutes in the future, older than 35 days, or during the trial are rejected with their reasons.
15. Usage and sealing racing: every accepted event is billed exactly once, on this invoice or the next.
16. A `max` meter with events 5, 12, 7 bills 12; a `sum` meter bills 24.
17. Graduated tiers (to 1,000 at 0; to 10,000 at 2; beyond at 1) with 12,500 units bill 20,500; volume mode bills 12,500; exactly 1,000 units bill 0 in both.
18. Zero usage produces no usage line; a period with no lines at all at cancellation produces no invoice.
19. Upgrade from 30.00 to 50.00 with `R = 10`, `D = 31`: credit −9.68, charge +16.13; at 8.25% tax the lines carry −0.80 and +1.33; total 6.98.
20. Seat increase from 3 to 5 at 10.00 per seat with `R = 15`, `D = 30`: credit −15.00, charge +25.00.
21. An upgrade on the first day of the period credits and charges the full amounts; on the last day `R = 1`.
22. A downgrade is scheduled; a second change request before the boundary replaces it; at the boundary the new plan's advance lines appear and the ended period's usage is rated with the old plan's tiers.
23. An upgrade to a plan without a meter bills that meter's usage so far on the proration invoice, once.
24. A change requested after the period end date but before the billing run is `409 renewal_in_progress`.
25. The same change request replayed with its idempotency key creates one proration invoice.
26. Trial of 14 days: no invoice until `trialEndsOn`; the first period starts that date; cancelling in trial produces nothing.
27. Cancel at period end: the boundary produces a `final` invoice with the last period's usage only, and no next-period charges; `resume` before the boundary restores normal billing.
28. Immediate cancel bills usage up to the instant; later events for that subscription are rejected with `subscription_ended`.
29. A second live subscription to the same product, created concurrently, yields one `201` and one `409`.
30. Invoice numbers within a year are consecutive with no gaps, including when a finalisation rolls back; the first invoice of a new year starts at 000001.
31. Any attempt to change a line, amount or number of a finalised invoice through the API is refused, and the same change by direct SQL is rejected by the database.
32. Tax is the sum of per-line rounded amounts: three lines of 0.33 at 10% give tax 0.09, not 0.10.
33. A regional tax rate takes precedence over the country rate; a rate ending on the issue date does not apply that day; tax-exempt customers get 0.
34. Credit balance larger than the total pays the invoice at finalisation with no payment attempt and leaves the remainder on the balance.
35. Voiding an open invoice returns applied credit to the balance once; voiding twice is `409`.
36. A decline schedules retries at 3, 5 and 7 days; the fourth decline marks the invoice uncollectible and cancels the subscription; open invoices of the canceled subscription keep being collected.
37. A gateway timeout leaves the attempt `unknown`; the next pass looks it up and never sends a second charge for it. If the gateway reports it succeeded, the invoice is paid once.
38. `Lookup` → `NotFound` does not count toward dunning and a new attempt (next `attemptNo`, new key) follows.
39. A worker crash after `Charge` returned and before the result was stored does not lead to a second charge.
40. A customer with no payment method counts as a decline without calling the gateway.
41. A `past_due` subscription returns to `active` only when its last declined open invoice is paid.
42. Two concurrent credit notes that together exceed a line's amount: one succeeds, one is `422`.
43. Crediting a line in two parts never credits more tax than the line carried; the second, final part takes the remaining tax.
44. A `reduce_due` credit note for the whole remaining amount settles an open invoice and stops dunning; a credit note during an in-flight payment is `409`.
45. Refund credit notes cannot exceed the amount actually paid minus earlier refunds; a refund that fails five times is `failed` and its amount becomes refundable again.
46. A webhook body verifies against the signature with the exact bytes received; within 24 h of rotation it also verifies with the old secret.
47. `invoice.finalized` and `invoice.paid` for one invoice reach an endpoint in that order even when the first delivery needs retries; events for other invoices are not held up.
48. Eight failed attempts mark a delivery `failed`; the next event for that object is then delivered; a manual retry delivers the failed one.
49. An endpoint answering `410` is disabled and receives nothing further; an endpoint added later does not receive older events.
50. An event whose transaction rolled back has no `webhook_events` row; a committed one is delivered even if the API process stops immediately after responding.

## 9. Non-goals

Real payment gateways, payment method collection, multi-currency customers, zero- and three-decimal currencies, tax-inclusive pricing, tax registration numbers, coupons and discounts, quotes, multiple subscriptions to one product, plan interval changes, automatic refunds on cancellation, PDF invoices, emails, customer portal, multi-tenant accounts, protection of webhook targets against internal addresses, UI.

## 10. Acceptance criteria

- Each subscription period has exactly one cycle (or final) invoice, whatever the number of workers or the length of an outage.
- Every accepted usage event is billed exactly once.
- Finalised invoices never change other than in their payment and credit columns; invoice numbers are gapless per year.
- A payment is never charged twice for one attempt, and credits and refunds never exceed what was invoiced or paid.
- The customer credit balance always equals the sum of its transactions and is never negative.
- Webhooks are signed, retried on the schedule, and delivered in order per object and endpoint.
- All edge cases in section 8 hold.

## 11. Required tests

Unit (`Billing.Domain.Tests`, no database):
- `addMonthsClamped` and period boundaries for month-end and leap-day anchors; `startOfDay` for normal, missing-midnight and repeated-midnight days; customer "today" across zones.
- Proration tables (credit and charge rounding, first and last day), seat changes.
- Tier rating for both modes at tier edges; `sum` and `max` aggregation.
- Tax rounding per line including negative lines; rate selection by date and region.
- Dunning schedule; webhook retry schedule; signature generation and verification with rotation.
- Credit-note tax split across partial credits.

Integration (Postgres, `WebApplicationFactory`, manual clock, fake gateway):
- Subscription creation with and without trial; concurrent duplicate subscription.
- Billing run: first invoice, boundary invoice contents, grace boundary, catch-up over several periods, two concurrent runs, cancel at period end, pending change applied.
- Usage: batch results, duplicates and conflicts, rejection reasons, late events, ingestion concurrent with sealing, final sealing.
- Plan change: increase with proration and dropped meter, decrease scheduling and replacement, renewal-in-progress, idempotent replay.
- Finalisation: numbering without gaps (with an injected failure), credit application, immutability through API and through SQL.
- Payments: success, decline schedule to exhaustion and subscription cancel, timeout then lookup success, lookup not found, crash between transactions, no payment method, `past_due` recovery.
- Credit notes: each disposition, limits under concurrency, in-flight payment conflict, refund retry and failure, balance ledger equality.
- Webhooks: outbox row with commit and none on rollback, fan-out by subscription, signature over exact bytes, retry schedule, per-object ordering, `410`, manual retry, crash after send.
- Permission matrix per role.

## 12. Commit plan

1. `chore`: solution, projects, `Directory.*.props`, configuration, logging, error handler and envelope, validation filter, compose, `.env.example`.
2. `feat`: domain library: money, calendar, proration, tier rating, tax, schedules, with unit tests.
3. `feat`: EF model, configurations, initial migration with triggers and constraints, model snapshot, `migrate` command.
4. `feat`: API keys and roles; customers, products, plans, meters, tax rates.
5. `feat`: subscriptions: create, trials, request idempotency.
6. `feat`: invoices: drafting, finalisation, numbering, credit application, manual invoices, void.
7. `feat`: worker host and billing run.
8. `feat`: usage ingestion, sealing and rating.
9. `feat`: plan and quantity changes with proration; cancellation and resume.
10. `feat`: payment gateway abstraction, payment loop, dunning.
11. `feat`: credit notes, refunds, customer credit ledger.
12. `feat`: webhook events, endpoints, fan-out and signed delivery.
13. `test`: concurrency suites, permission matrix, long-outage scenarios.
14. `docs`/`ci`: seed command, README, CI workflow.
