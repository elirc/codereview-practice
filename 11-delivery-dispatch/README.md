# Delivery Dispatch

The backend of a food-delivery platform as three Go services. **orders** quotes and takes orders and owns their lifecycle, **dispatch** offers each confirmed order to the nearest available courier and tracks the delivery, and **couriers** owns shifts, positions, reservations and earnings. Each service has its own Postgres database and they talk only through events on NATS JetStream, written to a transactional outbox.

## Setup

Requirements: Go 1.23, Docker (for Postgres 16 + PostGIS 3.4 and NATS 2.10).

```sh
cp .env.example .env            # then export it, e.g. `set -a; . ./.env; set +a`
go mod tidy                     # resolves indirect dependencies and writes go.sum
docker compose up -d            # Postgres 5463, NATS 6393 (monitoring 6394), test NATS 6395
go run ./services/orders/cmd/orders migrate up
go run ./services/dispatch/cmd/dispatch migrate up
go run ./services/couriers/cmd/couriers migrate up
go run ./services/orders/cmd/orders seed
go run ./services/couriers/cmd/couriers seed
```

`deploy/initdb/20-databases.sql` runs on the first start of the Postgres container and creates `dd_orders`, `dd_dispatch` and `dd_couriers`, each owned by its own role, with PostGIS in the two databases that store positions. Migrations (`goose`, embedded) also run with `down` and `status`.

The sqlc output in `services/*/internal/store/db` is committed. After changing a query or migration run `sqlc generate` (sqlc v1.27.0) in that service's folder.

## Run

Each service is one process; `serve` runs its HTTP API, outbox relay, consumers and loops. Run several instances of any of them if you like.

| Process | Command | Port |
|---|---|---|
| orders | `go run ./services/orders/cmd/orders serve` | 8111 |
| dispatch | `go run ./services/dispatch/cmd/dispatch serve` | 8112 |
| couriers | `go run ./services/couriers/cmd/couriers serve` | 8113 |
| dev tokens | `go run ./cmd/devtoken -role courier -sub <uuid>` | — |

Loops per service (all off when `LOOPS_ENABLED=false`): outbox relay (200 ms) and purge (hourly) everywhere; confirm sweeper (5 s) and cancel-request retry (30 s) in orders; offer loop (1 s), offer expiry (1 s), reservation expiry (2 s) and surge (30 s) in dispatch.

A walk-through with the seed tokens: a courier starts a shift and sends a location to couriers; a customer posts `/quotes` then `/orders` to orders; the restaurant confirms; the courier polls `GET /offers/current` on dispatch and accepts; then `POST /deliveries/{id}/pickup` and `/deliver`.

## Test

```sh
go test ./...                                   # unit tests; integration tests skip
docker compose up -d && set -a && . ./.env && set +a
go test -race -count=1 ./...                    # everything, including test/e2e
```

Integration tests use `TEST_DATABASE_URL_ORDERS`, `_DISPATCH` and `_COURIERS`; each test creates and drops its own schema. `test/e2e` also needs `TEST_NATS_URL`, which `.env.example` points at the separate `nats-test` server (port 6395) from `compose.yaml`; the suite deletes and recreates the three streams there before each test. Lint: `gofmt -l .`, `go vet ./...`, `staticcheck ./...` (2024.1.1).

## Architecture

```
pkg/
  apperr      typed errors (kind, code, message, details)
  auth        HS256 tokens: verify, mint, middleware, role checks, seed principals
  clock idgen injected time and ids
  config      env loader; logging slog JSON
  envelope    event envelope and validation
  outbox      emitter (insert in caller's tx), relay, purge, stats
  inbox       processor: inbox row + handler in one tx, NAK back-off, dead letters, replay
  natsx       streams, durable pull consumers, publisher, fetch loop, Drain
  httpx       request id, JSON decoding, error envelope, middleware
  opsapi      /ops/dead-letters, /ops/outbox/stats
  pgxtx       WithTx, unique-violation check, advisory keys
  geo         great-circle distance (orders)
  runner      periodic loops; migrate goose runner; pgtest test schemas
services/<svc>/
  cmd/<svc>   serve | migrate | seed
  app         wiring used by main and test/e2e
  internal/domain      pure rules
  internal/service     use cases, one transaction each
  internal/store       sqlc queries (queries/) and generated code (db/)
  internal/httpapi     handlers
  internal/consumers   event handlers
  internal/loops       periodic jobs
  migrations           goose SQL
cmd/devtoken, test/e2e, deploy/initdb
```

Ownership:

| Service | Tables | Publishes (stream `ORDERS`/`DISPATCH`/`COURIERS`) | Consumer → subjects |
|---|---|---|---|
| orders | restaurants, zone_surge, quotes, orders, order_status_history, outbox, inbox, dead_letters | `orders.order.confirmed`, `.cancel_requested`, `.cancelled` | `orders-on-DISPATCH` → `dispatch.delivery.{assigned,unassigned,picked_up,delivered,cancelled,cancel_rejected,failed}`, `dispatch.surge.updated` |
| dispatch | deliveries, offers, courier_view, cancelled_orders, zone_surge, outbox, inbox, dead_letters | `dispatch.delivery.*`, `dispatch.surge.updated` | `dispatch-on-ORDERS` → `orders.order.{confirmed,cancel_requested}`; `dispatch-on-COURIERS` → `couriers.courier.{status_changed,location_updated,reserved,reservation_rejected}` |
| couriers | couriers, courier_earnings, outbox, inbox, dead_letters | `couriers.courier.status_changed`, `.location_updated`, `.reserved`, `.reservation_rejected` | `couriers-on-DISPATCH` → `dispatch.delivery.{courier_requested,courier_released,unassigned,delivered,cancelled}` |

Request flow: router (request id → access log → recover → bearer auth) → handler (decode and validate) → service (transaction: state change + outbox row) → `httpx.WriteError` for failures. Event flow: outbox relay → JetStream → durable pull consumer → `inbox.Processor` (inbox row and handler in one transaction) → ack, NAK with back-off, or dead letter.

## Where the hard parts live

| Topic | Files |
|---|---|
| Transactional outbox and relay | `pkg/outbox/outbox.go`, `pkg/outbox/relay.go` |
| Inbox, retries, dead letters, replay | `pkg/inbox/inbox.go`, `pkg/inbox/deadletters.go`, `pkg/natsx/consumer.go` |
| Idempotent placement and active-order limit | `services/orders/internal/service/orders.go` |
| Confirm deadline and sweeper | `services/orders/internal/service/lifecycle.go` |
| Applying delivery events by sequence | `services/orders/internal/domain/delivery.go`, `services/orders/internal/service/deliveryevents.go` |
| Cancellation saga | `services/orders/internal/service/cancel.go`, `services/dispatch/internal/service/cancel.go`, `services/dispatch/internal/domain/cancel.go`, `services/couriers/internal/service/earnings.go` |
| Candidate selection and the offer loop | `services/dispatch/internal/store/queries/offers.sql`, `services/dispatch/internal/service/offers.go` |
| Courier projection | `services/dispatch/internal/service/projection.go`, `services/dispatch/internal/store/queries/couriers.sql` |
| Reservation handshake | `services/dispatch/internal/service/reservations.go`, `services/couriers/internal/service/reservations.go`, `services/couriers/internal/domain/reservation.go` |
| Pickup, delivery, abandon | `services/dispatch/internal/service/actions.go` |
| Location throttling | `services/couriers/internal/service/location.go`, `services/couriers/internal/domain/location.go` |
| Fees, payout, ETA, surge | `services/orders/internal/domain/pricing.go`, `services/dispatch/internal/domain/payout.go`, `services/dispatch/internal/domain/eta.go`, `services/dispatch/internal/domain/surge.go`, `services/dispatch/internal/service/surge.go` |
| Database invariants | `services/*/migrations/00002_*.sql` |

## Seed accounts

`orders seed` and `couriers seed` print a 30-day token for each account (signed with `AUTH_JWT_SECRET`); `devtoken` mints others.

To rotate the signing secret, move the old value to `AUTH_JWT_PREVIOUS_SECRET` and set a new `AUTH_JWT_SECRET`; tokens signed with either are accepted until the previous secret is removed.

| Account | Role | Subject | Notes |
|---|---|---|---|
| customer | customer | `11111111-1111-4111-8111-111111111111` | |
| restaurant | restaurant | `22222222-2222-4222-8222-222222222222` | `restaurant_id` `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` (Iya Basira Kitchen, lagos-yaba) |
| ops | ops | `33333333-3333-4333-8333-333333333333` | |
| courier-1 | courier | `cccccccc-cccc-4ccc-8ccc-000000000001` | Tunde Bike |
| courier-2 | courier | `cccccccc-cccc-4ccc-8ccc-000000000002` | Amaka Scooter |
| courier-3 | courier | `cccccccc-cccc-4ccc-8ccc-000000000003` | Chidi Car |

Seeded restaurants: Iya Basira Kitchen (lagos-yaba), Suya Spot Ikeja (lagos-ikeja), and an inactive one. Couriers start off shift.
