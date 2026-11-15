# Event Ticketing with Waitlists

Organisers publish events with ticket tiers of limited capacity. Customers place a ten-minute hold on tickets, apply promo codes and check out through a payment gateway interface; sold-out tiers have a first-in-first-out waitlist that is offered tickets as they free up. Built with Rails 8, PostgreSQL and Solid Queue.

## Setup

Requirements: Ruby 3.3.6, Bundler, Docker (for PostgreSQL 16).

```sh
cd 05-event-ticketing
docker compose up -d                # PostgreSQL on localhost:5455
bundle install                      # also writes Gemfile.lock
cp .env.example .env                # adjust if needed
set -a; . ./.env; set +a            # Rails does not read .env itself
bin/rails db:prepare                # creates the databases, loads the schema, runs db/seeds.rb
```

Configuration is read once at boot by `lib/app_config.rb`; boot fails with a list of problems if a value is missing or malformed. Every variable is listed in `.env.example`. In development and test the database settings default to the compose service, so `DATABASE_URL` is only required in production.

The JavaScript (Turbo, Stimulus) is served from the `turbo-rails` and `stimulus-rails` gems through import maps; there is no Node build step and nothing to download.

## Run

```sh
bin/dev       # web server on http://localhost:3000
bin/jobs      # Solid Queue worker, dispatcher and recurring scheduler
```

Recurring tasks (`config/recurring.yml`): `SweepExpiredHoldsJob` every minute and `SweepWaitlistJob` every five minutes. Letters are written to the log as `mail.delivered` entries instead of being sent. The fake payment gateway approves every token except `tok_decline`; set `FAKE_GATEWAY_MODE=decline` to decline everything.

## Test

```sh
docker compose up -d
bin/rails db:test:prepare
bin/rails test
bin/rubocop
```

Tests use Minitest with fixtures and fixed clocks (`travel_to`, or an explicit `now:` passed to services). The tests in `test/concurrency` run several threads with their own database connections outside the usual test transaction and clean up after themselves.

## Architecture

```
app/
  controllers/          thin HTTP layer; Manage::* for organisers, Admin::* for admins, Api::* for JSON
    concerns/           Authentication (signed session cookie) and ErrorHandling (codes -> responses)
  errors/               DomainError, the error catalog (code -> status, message) and the JSON envelope
  jobs/                 expiry, sweeps, waitlist promotion, event cancellation
  mailers/              order confirmation/refund/cancellation and waitlist offer letters
  models/               Active Record models plus TierAvailability (read model for the event page and API)
  policies/             plain policy objects consulted by controllers
  services/             business operations:
    holds/              Create, Release, Expire, Closing (shared), EventAllowance (per-event cap)
    promos/             Apply, Validation
    pricing/            Quote (pure)
    checkout/           Complete
    waitlist/           Join, Leave, Promote
    orders/             Refund
    tiers/              Update
    events/             Cancel
    payment_gateway.rb  gateway interface; fake_gateway.rb is the dev/test implementation
  javascript/controllers/  Stimulus: hold countdown, availability polling
lib/                    AppConfig, JSON log formatter, request-id log context, log mail delivery
db/                     migrations, schema.rb (includes the Solid Queue tables), seeds.rb
```

Request flow: a controller authenticates the user, checks policies or scopes the lookup to the current user, validates parameters, and calls one service. Services run in a database transaction that takes row locks in one order (user, tier, hold, promo codes by id, waitlist entries), raise `DomainError` with a stable code when a rule is broken, and enqueue jobs and mail once the transaction has committed. `ErrorHandling` turns `DomainError` into a redirect with a flash carrying the error code (HTML), a re-rendered quote frame (Turbo Stream, promo codes), or the JSON error envelope (API).

Job flow: creating a hold schedules `ExpireHoldJob` at its expiry; releasing, expiring, refunding, leaving the waitlist and raising capacity enqueue `PromoteWaitlistJob` for the tier. `SweepExpiredHoldsJob` and `SweepWaitlistJob` run on a schedule alongside them. Cancelling an event marks it cancelled immediately and leaves releasing holds, closing waitlists and refunding orders to `CancelEventJob`, one order per transaction.

The payment gateway is called inside the checkout transaction while the tier row is locked. That keeps the order, tickets, counters and charge consistent with a single transaction at the cost of holding the tier lock for the duration of the gateway call; it is an accepted trade-off for this application's volume. If the transaction fails after a successful charge, the charge is voided before the error is re-raised.

Logs are one JSON object per line and include the request id (taken from `X-Request-Id` when present). Jobs log start, finish and failure with their id and attempt number.

## Where the hard parts live

| Topic | Files |
|---|---|
| Capacity counters and locking | `app/models/ticket_tier.rb`, `app/services/holds/create.rb`, `app/services/holds/closing.rb`, `db/migrate/20261114090400_create_ticket_tiers.rb` |
| Hold replacement and per-event cap | `app/services/holds/create.rb`, `app/services/holds/event_allowance.rb` |
| Expiry by time, jobs and sweep | `app/models/hold.rb`, `app/services/holds/expire.rb`, `app/services/holds/expire_batch.rb`, `app/jobs/expire_hold_job.rb`, `app/jobs/sweep_expired_holds_job.rb` |
| Checkout, payment and voiding | `app/services/checkout/complete.rb`, `app/services/payment_gateway.rb`, `app/services/fake_gateway.rb` |
| Promo validity, stacking and pricing | `app/services/promos/validation.rb`, `app/services/promos/apply.rb`, `app/services/pricing/quote.rb`, `app/models/promo_code.rb` |
| Waitlist ordering and promotion | `app/services/waitlist/promote.rb`, `app/services/waitlist/join.rb`, `app/services/waitlist/leave.rb`, `app/jobs/promote_waitlist_job.rb`, `app/jobs/sweep_waitlist_job.rb` |
| Refunds, capacity edits, cancellation | `app/services/orders/refund.rb`, `app/services/tiers/update.rb`, `app/services/events/cancel.rb`, `app/jobs/cancel_event_job.rb` |
| After-commit enqueueing | `app/jobs/application_job.rb`, the services above |
| Authorisation and scoping | `app/policies/`, `app/controllers/manage/base_controller.rb`, `app/controllers/holds_controller.rb`, `app/controllers/orders_controller.rb` |
| Errors and envelope | `app/errors/`, `app/controllers/concerns/error_handling.rb`, `app/controllers/api/base_controller.rb` |
| Time zones on forms | `app/models/concerns/zoned_time_input.rb` |
| Concurrency tests | `test/concurrency/`, `test/support/concurrency_test_case.rb` |

## Seed accounts

All seed accounts use the password `password123`.

| Role | Email |
|---|---|
| Admin | admin@example.com |
| Organiser (Harbour Lights Live, Unannounced Winter Show) | organizer@example.com |
| Organiser (Riverside Folk Festival) | organizer2@example.com |
| Customer (owns the sold-out front-row order) | customer@example.com |
| Customer (has an order with a promo and is on the front-row waitlist) | customer2@example.com |

Seeded promo codes for Harbour Lights Live: `EARLYBIRD` (15%, stackable, 50 uses), `TENOFF` ($10, stackable), `VIPONLY` (20% on VIP over $200). Site-wide: `WELCOME5` ($5, once per customer).
