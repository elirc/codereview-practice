# SaaS Billing

A subscription billing API for one software business. It keeps customers, a catalogue of flat, per-seat and tiered usage plans, and subscriptions with trials and mid-cycle changes; a worker turns each billing period into one invoice, rates metered usage, applies tax and customer credit, collects payment with a dunning schedule, and delivers signed webhooks. There is no UI.

## Setup

Requirements: the .NET 10 SDK (`global.json` pins 10.0.100 with `rollForward: latestFeature`) and Docker for Postgres 16.

```sh
cp .env.example .env              # adjust if needed
set -a; . ./.env; set +a          # the processes read configuration from the environment only
docker compose up -d postgres     # Postgres on localhost:5464 with databases billing and billing_test
dotnet restore Billing.slnx       # no lock files are committed; restore resolves the pinned versions
dotnet run --project src/Billing.Api -- migrate
dotnet run --project src/Billing.Api -- seed
```

Configuration is read from environment variables only (see `.env.example`); `.env` is not loaded automatically. `DATABASE_URL` is required and accepts a `postgres://user:password@host:port/db` URL or an Npgsql connection string. The process stops at start-up when a value is missing or invalid.

## Run

| Process | Command | Notes |
|---|---|---|
| API | `dotnet run --project src/Billing.Api` | Listens on `PORT` (8120) |
| Worker | `dotnet run --project src/Billing.Worker` | Runs the loops listed in `WORKER_LOOPS`; several instances may run at once |
| Migrations | `dotnet run --project src/Billing.Api -- migrate` | The only way the schema is changed; nothing is migrated at start-up |
| Seed | `dotnet run --project src/Billing.Api -- seed` | Idempotent development data; refuses to run unless `ASPNETCORE_ENVIRONMENT` is set to something other than `Production` |

The `migrate` and `seed` commands must be the first argument after `--`.

Worker loops and their intervals: `billing` (60 s), `payments` (30 s), `refunds` (60 s), `webhook-fanout` (2 s), `webhook-delivery` (2 s), `purge` (daily).

Every request needs `Authorization: Bearer <api key>`. `POST /v1/subscriptions`, `/subscriptions/{id}/change`, `/subscriptions/{id}/cancel`, `/invoices/{id}/credit-notes` and `/customers/{id}/credit-adjustments` also need an `Idempotency-Key` header (8–128 characters). `POST /v1/invoices`, `/invoices/{id}/finalize`, `/invoices/{id}/void` and `/invoices/{id}/pay` accept one too; without it they run as before.

Webhook receivers verify `Billing-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]`, where `v1` is the lower-case hex HMAC-SHA256 of `"<t>." + raw body`, keyed with the UTF-8 bytes of the endpoint secret (including its `whsec_` prefix).

## Test

```sh
docker compose up -d postgres
export TEST_DATABASE_URL=postgres://billing:billing@localhost:5464/billing_test
dotnet test Billing.slnx
dotnet format Billing.slnx --verify-no-changes
```

`Billing.Domain.Tests` needs no database. `Billing.IntegrationTests` hosts the API with `WebApplicationFactory`, applies the migrations to `TEST_DATABASE_URL`, truncates every table before each test, and replaces the clock with a manual `TimeProvider`, the gateway with the scripted fake and the webhook HTTP handler with a recording one. Worker loops are not started in tests; tests call each loop's `RunOnceAsync(now)` directly.

## Architecture

```
src/
  Billing.Domain/        pure rules: calendar and periods, proration, tier rating, tax, schedules, signatures
  Billing.Core/
    Data/                entities, EF configurations, naming pass, row locks and transaction helpers
    Migrations/          hand-written InitialSchema migration and model snapshot
    Services/            application services and worker loop runners
    Payments/            IPaymentGateway and the scripted FakeGateway
    Webhooks/            endpoints, fan-out, delivery, sender, purge
    Views/               API representations, also used as webhook data.object
  Billing.Api/           minimal API endpoints, request validation, auth, error envelope, migrate and seed commands
  Billing.Worker/        generic host with one BackgroundService per loop
tests/
  Billing.Domain.Tests/  unit tests
  Billing.IntegrationTests/  HTTP and loop tests against Postgres
```

Request flow: `RequestIdMiddleware` assigns the request id and logging scope → `UseExceptionHandler` with `ApiExceptionHandler` renders every failure as the error envelope → routing → `ApiKeyMiddleware` resolves the bearer key into a `Caller` and checks the roles the endpoint allows (`RequireRole` metadata) → the endpoint's validation filter → the handler calls a Core service, which does its work in one transaction. Webhook events are written to `webhook_events` inside that same transaction.

Job flow: each worker loop creates a scope per pass and calls its runner's `RunOnceAsync(now)`. Runners list due work, then handle each item in its own scope and transaction.

| Process | Writes |
|---|---|
| API | customers, credit_balance_transactions, products, plans, plan_items, price_tiers, meters, tax_rates, subscriptions, subscription_periods, usage_events, invoices, invoice_lines, credit_notes, credit_note_lines, counters, webhook_endpoints, webhook_events, webhook_deliveries (manual retry), idempotency_records, api_keys |
| Worker: billing | subscriptions, subscription_periods, usage_events (sealing), invoices, invoice_lines, counters, credit_balance_transactions, webhook_events |
| Worker: payments | payment_attempts, invoices, subscriptions (status, dunning cancel), webhook_events |
| Worker: refunds | credit_notes, invoices (refunded amount), webhook_events |
| Worker: webhook fan-out | webhook_events (fanned out), webhook_deliveries |
| Worker: webhook delivery | webhook_deliveries, webhook_endpoints (disable on 410) |
| Worker: purge | idempotency_records, webhook_deliveries |

## Where the hard parts live

| Topic | Files |
|---|---|
| Period boundaries, start of day, customer today | `src/Billing.Domain/BillingCalendar.cs`, `src/Billing.Core/Services/SubscriptionCycle.cs` |
| Billing run and boundary claims | `src/Billing.Core/Services/BillingRun.cs` |
| Usage ingestion | `src/Billing.Core/Services/UsageService.cs` |
| Usage sealing and rating | `src/Billing.Core/Services/UsageRating.cs`, `src/Billing.Domain/TierRating.cs` |
| Proration, plan changes, cancellation | `src/Billing.Core/Services/SubscriptionLifecycle.cs`, `src/Billing.Domain/Proration.cs` |
| Finalisation, numbering, credit application | `src/Billing.Core/Services/InvoiceFinalizer.cs`, `src/Billing.Core/Services/CreditLedger.cs` |
| Tax | `src/Billing.Domain/Tax.cs` |
| Payments and dunning | `src/Billing.Core/Services/PaymentRun.cs`, `src/Billing.Core/Services/InvoiceSettlement.cs`, `src/Billing.Domain/Schedules.cs` |
| Credit notes and refunds | `src/Billing.Core/Services/CreditNoteService.cs`, `src/Billing.Core/Services/RefundRun.cs` |
| Webhook outbox, fan-out and delivery | `src/Billing.Core/Services/EventRecorder.cs`, `src/Billing.Core/Webhooks/WebhookFanOut.cs`, `src/Billing.Core/Webhooks/WebhookDispatcher.cs`, `src/Billing.Domain/WebhookSignature.cs` |
| Request idempotency | `src/Billing.Api/Infrastructure/IdempotentExecutor.cs` |
| Row locks and transactions | `src/Billing.Core/Data/DbContextExtensions.cs` |
| Database invariants | `src/Billing.Core/Migrations/20261101000000_InitialSchema.cs` |
| Error envelope and validation | `src/Billing.Api/Infrastructure/ApiExceptionHandler.cs`, `src/Billing.Api/Validation/` |

## Seed accounts

`seed` creates one API key per role. These keys are for local development only.

| Role | API key |
|---|---|
| service | `bk_dev_service_7c1e5a9d3f2b4e8a6d0c9b1f5e3a7d2c` |
| support | `bk_dev_support_2a8f4c6e0b9d1f3a5c7e9b2d4f6a8c0e` |
| billing_ops | `bk_dev_billing_ops_9e3b7d1f5a2c8e4b6d0f3a9c1e5b7d2f` |
| admin | `bk_dev_admin_4d6f8a0c2e9b1d3f5a7c9e2b4d6f8a1c` |

It also creates the product `Platform` with plans `starter-monthly` (14-day trial), `team-monthly` (flat, seats and graduated API calls), `team-yearly` and `team-monthly-eur`; meters `api_calls` (sum) and `peak_seats` (max); tax rates for US-CA, DE and NZ; and three customers: `acme` (Los Angeles, card `tok_ok`, active on `team-monthly`), `kiwi` (Auckland, card `tok_decline_card_declined`, trialing on `starter-monthly`) and `berlin` (Berlin, EUR, no payment method, active on `team-monthly-eur`).

```sh
curl -H "Authorization: Bearer bk_dev_support_2a8f4c6e0b9d1f3a5c7e9b2d4f6a8c0e" http://localhost:8120/v1/customers
```
