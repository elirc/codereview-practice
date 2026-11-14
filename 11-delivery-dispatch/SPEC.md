# 11 — Delivery Dispatch

## 1. Purpose

The backend of a food-delivery platform, split into three Go services. **orders** takes quotes and orders and owns the order lifecycle. **dispatch** finds a courier for each confirmed order by offering it to the nearest available courier, one at a time, and tracks the delivery to the door. **couriers** owns courier shifts, location pings, reservations and earnings. Each service has its own Postgres database and talks to the others only through events on NATS JetStream, published from a transactional outbox. API only; there is no UI. Read `../CONVENTIONS.md` first, including section 12.

Conventions pointer: doc comments and comments say what a function does and returns. They never name the race, redelivery, reordering or double assignment a piece of code is there for, and never describe the locking, deduplication, sequencing or compensation design (CONVENTIONS §4 and §12.1).

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Language | Go 1.23, one module `deliverydispatch` (`go.mod` at the project root) |
| HTTP | `github.com/go-chi/chi/v5` v5.2.0, `net/http` |
| DB | PostgreSQL 16 with PostGIS 3.4 (`postgis/postgis:16-3.4`, one container, compose host port 5463) holding three databases `dd_orders`, `dd_dispatch`, `dd_couriers`, each with its own role, created by `deploy/initdb/*.sql`. `github.com/jackc/pgx/v5` v5.7.2 (`pgxpool`) |
| Queries | sqlc v1.27.0, one `sqlc.yaml` per service (`engine: postgresql`, `sql_package: pgx/v5`, `emit_interface: true`). Query files in `services/<svc>/internal/store/queries/*.sql`; output in `services/<svc>/internal/store/db/` **hand-written exactly as sqlc would emit** (header, `versions: sqlc v1.27.0`, pgx/v5 type mapping). Queries never `SELECT *` |
| Geo | Coordinates are stored as `lon`, `lat` `double precision` columns. PostGIS is used in queries and indexes through `ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography`; a GiST index on that expression exists on `courier_view`. No geometry or geography value is ever scanned into Go; distances come back as `float8` metres. Pure-Go great-circle distance lives in `pkg/geo` for the services that have no courier positions |
| Migrations | `github.com/pressly/goose/v3` v3.24.0, SQL files per service in `services/<svc>/migrations/`, embedded; `<svc> migrate up` |
| Messaging | NATS 2.10 with JetStream (`nats:2.10-alpine -js`, compose host ports 6393 client, 6394 monitoring). `github.com/nats-io/nats.go` v1.37.0 using the `jetstream` package: `jetstream.New`, `CreateOrUpdateStream`, `CreateOrUpdateConsumer`, `Consumer.Fetch`, `Msg.Ack`, `Msg.NakWithDelay`, `Msg.Metadata`, `Publish` with `jetstream.WithMsgID` |
| Auth | HS256 bearer tokens, `github.com/golang-jwt/jwt/v5` v5.2.1, verified in `pkg/auth` with `AUTH_JWT_SECRET`. Claims: `sub` (UUID), `role`, `restaurant_id?`, `exp`. Tokens are minted by `cmd/devtoken` and the seed; there is no identity service |
| Ids | `github.com/google/uuid` v1.6.0 through an injected generator |
| Logging | `log/slog` JSON; request id middleware; consumers log `event_id`, `type`, `delivery_count` |
| Tests | `testing`, table-driven. Integration tests use real databases from `TEST_DATABASE_URL_ORDERS`/`_DISPATCH`/`_COURIERS` and skip when unset. Consumer handlers are tested by calling them with envelopes. `test/e2e` wires the three services in one process against real databases and NATS from `TEST_NATS_URL` |
| Lint | `gofmt`, `go vet`, staticcheck 2024.1.1 |

Layout:

```
pkg/            envelope, outbox (relay), inbox, natsx (streams, consumer runner), httpx (errors, JSON, request id),
                auth, clock, idgen, config, logging, geo, pgxtx (WithTx helper)
services/orders|dispatch|couriers/
    cmd/<svc>/main.go        subcommands: serve, migrate, seed
    app/                     New(cfg, deps) *App: router, loops, consumers (used by main and by test/e2e)
    internal/domain          pure rules
    internal/service         transactions
    internal/store           sqlc queries and output
    internal/httpapi         handlers
    internal/consumers       event handlers
    internal/loops           periodic work
    migrations/
cmd/devtoken/
test/e2e/
deploy/initdb/
```

HTTP ports: orders 8111, dispatch 8112, couriers 8113. `serve` runs the HTTP server, the outbox relay, the consumers and the loops of that service in one process; every part tolerates several instances of the service.

Each database has its own `outbox`, `inbox` and `dead_letters` tables with identical shapes, created by that service's migrations. Money is `int64` minor units of the single currency `APP_CURRENCY` (default `USD`). JSON is `snake_case`.

## 3. Roles and permissions

| Action | Service | customer | restaurant | courier | ops |
|---|---|---|---|---|---|
| Create quote, place order | orders | yes | no | no | no |
| Read an order | orders | own | orders of own restaurant | no | any |
| Confirm or reject an order | orders | no | own restaurant | no | yes |
| Request cancellation | orders | own | own restaurant | no | yes |
| List restaurants | orders | yes | yes | no | yes |
| Start/end shift, send location | couriers | no | no | self | no |
| Read courier profile and earnings | couriers | no | no | self | any |
| Suspend or reinstate a courier, create couriers | couriers | no | no | no | yes |
| Read current offer; accept or decline an offer | dispatch | no | no | the offered courier | no |
| Pickup, deliver, abandon | dispatch | no | no | the delivery's courier | no |
| Read a delivery | dispatch | no | no | its courier | any |
| Read zone surge, dead letters; replay a dead letter | all three | no | no | no | yes |

An order, offer or delivery that the caller may not see returns `404 not_found`. A role that may never call an endpoint gets `403 forbidden`. A `restaurant` token must carry `restaurant_id`.

## 4. Domain model

### orders (`dd_orders`)

- **Restaurant**: `id`, `name`, `zone_id` (text), `lon`, `lat`, `prep_minutes` (1–120), `active`.
- **ZoneSurge**: `zone_id`, `multiplier_bps`, `version`, `updated_at` (projection of `surge.updated`; absent zone means 10000).
- **Quote**: `id`, `customer_id`, `restaurant_id`, `items` (jsonb), `subtotal_minor`, `distance_m`, `delivery_fee_minor`, `surge_bps`, `total_minor`, `eta_minutes`, `dropoff_lon`, `dropoff_lat`, `expires_at`, `used_order_id?`.
- **Order**: `id`, `customer_id`, `restaurant_id`, `zone_id`, `quote_id` (unique), `client_order_key`, `status` (`placed` | `confirmed` | `courier_assigned` | `picked_up` | `delivered` | `cancelled`), `items`, money columns copied from the quote, pickup and drop-off coordinates, `confirm_deadline`, `ready_at?`, `courier_id?`, `eta_minutes?`, `delivery_sequence` (bigint, default 0), `cancel_request` (`none` | `pending` | `rejected`), `cancel_requested_by?`, `cancel_requested_at?`, `cancel_request_attempts`, `cancel_reason?` (`customer` | `restaurant` | `ops` | `restaurant_rejected` | `confirm_timeout` | `no_courier`), `cancellation_fee_minor`, `refund_minor`, `version`, timestamps. Unique `(customer_id, client_order_key)`.
- **OrderStatusHistory**: `order_id`, `version`, `status`, `at`, `cause`.

### dispatch (`dd_dispatch`)

- **Delivery**: `id` (equal to the order id), `zone_id`, `status` (`searching` | `offered` | `reserving` | `assigned` | `picked_up` | `delivered` | `cancelled` | `failed`), pickup and drop-off coordinates, `ready_at`, `delivery_fee_minor`, `surge_bps`, `courier_id?`, `offers_made`, `next_offer_at`, `search_deadline`, `reserve_deadline?`, `eta_minutes?`, `courier_was_assigned` (set on cancel), `courier_payout_minor?`, `version` (bigint; the `sequence` of its events), timestamps.
- **Offer**: `id`, `delivery_id`, `courier_id`, `status` (`pending` | `accepted` | `declined` | `expired` | `cancelled`), `distance_m`, `expires_at`, `created_at`, `closed_at?`.
- **CourierView**: `courier_id`, `zone_id?`, `status` (`offline` | `available` | `busy`), `vehicle`, `status_version`, `lon?`, `lat?`, `position_at?`.
- **CancelledOrder**: `order_id`, `requested_at` (a cancellation that arrived before its order).
- **ZoneSurge**: `zone_id`, `multiplier_bps`, `version`, `computed_at`.

Indexes: unique `offers (delivery_id) WHERE status = 'pending'`; unique `offers (courier_id) WHERE status = 'pending'`; unique `deliveries (courier_id) WHERE status IN ('reserving','assigned','picked_up')`; unique `offers (delivery_id, courier_id)`.

### couriers (`dd_couriers`)

- **Courier**: `id`, `name`, `vehicle` (`bike` | `scooter` | `car`), `suspended`, `shift_zone_id?` (non-null while on shift), `active_delivery_id?`, `status_version`, `lon?`, `lat?`, `position_at?`, `published_lon?`, `published_lat?`, `published_at?`, `position_seq`.
- **CourierEarning**: `id`, `courier_id`, `delivery_id`, `kind` (`delivery` | `cancellation_compensation`), `amount_minor`, `created_at`; unique `(courier_id, delivery_id, kind)`.

Courier status is derived, never stored: `busy` when `active_delivery_id` is set; otherwise `available` when on shift and not suspended; otherwise `offline`.

### Shared table shapes

- **outbox**: `id` (bigint identity), `event_id` (unique), `subject`, `payload` (jsonb envelope), `created_at`, `published_at?`, `attempts`, `last_error?`.
- **inbox**: `consumer`, `event_id`, `processed_at`; primary key `(consumer, event_id)`.
- **dead_letters**: `id`, `consumer`, `event_id`, `subject`, `payload`, `error`, `delivery_count`, `created_at`, `replayed_at?`.

## 5. Domain rules

### 5.1 Quotes and placing an order (orders)

- `POST /quotes` `{ restaurant_id, items: [{ name, quantity (1–50), unit_price_minor (> 0) }] (1–40), dropoff: { lon, lat } }`. Restaurant must be active. `distance_m` is the great-circle distance restaurant → drop-off, rounded up to a metre; over `MAX_DISTANCE_M` (15,000) → `422 out_of_range`.
- `delivery_fee_minor = roundHalfUp((BASE_FEE_MINOR × 1000 + PER_KM_MINOR × distance_m) × surge_bps / (1000 × 10000))` in integer arithmetic, with `surge_bps` from the zone projection at that moment. `total = subtotal + fee`. `eta_minutes = prep_minutes + ceil(distance_m × 1.3 / 333) + 5`. The quote expires `QUOTE_TTL` (5 min) after creation.
- `POST /orders` `{ quote_id, client_order_key (8–64 chars) }`. In one transaction: take a transaction-scoped advisory lock on the customer id; if an order with this `(customer_id, client_order_key)` exists, return it with `200` when its `quote_id` matches, else `422 idempotency_key_reused`; the quote must belong to the caller (`404`), have `now < expires_at` (`422 quote_expired`) and be unused, marked used by a conditional update (`409 quote_already_used`); the customer must have fewer than `MAX_ACTIVE_ORDERS` (3) orders that are not `delivered` or `cancelled` (`422 too_many_active_orders`). The order copies every amount from the quote; a later surge change does not affect it. `confirm_deadline = now + CONFIRM_TIMEOUT` (5 min). Status `placed`. No event.

### 5.2 Order lifecycle (orders)

| From | To | Trigger |
|---|---|---|
| `placed` | `confirmed` | restaurant confirm while `now < confirm_deadline`; sets `ready_at = now + prep_minutes`; emits `order.confirmed` |
| `placed` | `cancelled` | restaurant reject (`restaurant_rejected`), customer/ops cancel, or the confirm sweeper when `now >= confirm_deadline` (`confirm_timeout`); refund in full; emits `order.cancelled` |
| `confirmed` ⇄ `courier_assigned` | | `delivery.assigned` / `delivery.unassigned` |
| any non-terminal | `picked_up`, `delivered` | `delivery.picked_up`, `delivery.delivered` |
| `confirmed`, `courier_assigned` | `cancelled` | `delivery.cancelled` (answer to a cancel request) or `delivery.failed` (`no_courier`) |

- A confirm at or after `confirm_deadline` is `409 confirm_window_closed`, whether or not the sweeper has run.
- Every transition is a conditional update on the current `status` and `version` under a row lock, increments `version`, and writes history and any event in the same transaction.
- `delivered` and `cancelled` are terminal; nothing changes a terminal order.

**Applying delivery events.** Every `delivery.*` event carries the delivery's `sequence`. The handler locks the order; if the order is terminal or `event.sequence <= order.delivery_sequence`, it is a no-op. Otherwise it stores the sequence and applies the event's meaning directly, whatever the previous non-terminal status: `assigned` → `courier_assigned` with `courier_id`, `eta_minutes`; `unassigned` → `confirmed`, courier cleared; `picked_up` → `picked_up` (courier from the event); `delivered` → `delivered`; `cancelled`, `failed`, `cancel_rejected` as in 5.3. Events may therefore be skipped but never applied backwards. A `delivery.*` event for an order id that does not exist is an error (redelivered, then dead-lettered).

### 5.3 Cancellation (saga)

- `POST /orders/{id}/cancel` `{ reason? }`:
  - `placed` → cancelled at once, full refund, `200`.
  - `confirmed` or `courier_assigned` → `cancel_request = pending`, emit `order.cancel_requested`, `202`. If already `pending`, return `202` and emit nothing.
  - `picked_up`, `delivered`, `cancelled` → `409 not_cancellable`.
- dispatch decides (5.8) and answers with exactly one of:
  - `delivery.cancelled` → order `cancelled`, `cancel_reason` from who asked. `cancellation_fee_minor` is 0 when `courier_was_assigned` is false, when the restaurant asked, or when ops asked; otherwise `min(CANCEL_FEE_MINOR, total_minor)`. `refund_minor = total_minor − cancellation_fee_minor`. Emits `order.cancelled`.
  - `delivery.cancel_rejected` → `cancel_request = rejected`; the order carries on. A later cancel request is judged afresh by status.
  - `delivery.failed` → order `cancelled` with `no_courier`, full refund, whatever the cancel request state.
- A pending request with no answer after `CANCEL_REQUEST_RETRY` (2 min) is emitted again by a sweeper (new event id, same data), at most 5 times; after that the order is flagged in logs and left `pending` for ops.
- The refund is a recorded amount only; no payment system exists.

### 5.4 Courier shifts, status and location (couriers)

- `POST /couriers/me/shift/start` `{ zone_id }`: refused when suspended (`403 courier_suspended`); idempotent when already on shift in that zone; changing zone while on shift requires ending the shift first (`409 shift_active`).
- `POST /couriers/me/shift/end`: refused with `409 active_delivery` while `active_delivery_id` is set.
- Suspend (ops): sets `suspended`. The derived status becomes `offline` unless a delivery is active; an active delivery continues and is paid, and when it ends the courier is `offline`. Reinstating does not start a shift.
- Any change that alters the derived status, zone or suspension increments `status_version` and emits `courier.status_changed` with the derived status.
- `POST /couriers/me/location` `{ lon, lat, recorded_at }`: `lon` in [−180, 180], `lat` in [−90, 90]; `recorded_at` more than 30 s ahead of now → `422 timestamp_in_future`; more than 5 min old → accepted and discarded. The stored position is replaced only when `recorded_at > position_at`. `courier.location_updated` is emitted (with `position_seq + 1`) only when the courier is on shift and either `published_at` is null, `recorded_at − published_at >= 10 s`, or the new point is at least 50 m from the published one. Response is `204` in every accepted case.

### 5.5 Courier projection (dispatch)

- `courier.status_changed` upserts `CourierView` and applies `status`, `zone_id`, `vehicle` only when `sequence > status_version`.
- `courier.location_updated` upserts and applies the position only when `recorded_at > position_at` (or none stored). It never changes status. A location for an unknown courier creates the row as `offline`.
- When an applied status is not `available` and the courier has a `pending` offer, that offer becomes `cancelled` and its delivery returns to `searching` with `next_offer_at = now` in the same transaction.

### 5.6 Offers (dispatch)

A delivery is created `searching` by `order.confirmed` with `search_deadline = now + SEARCH_TIMEOUT` (10 min) and `next_offer_at = now`, unless a `CancelledOrder` row exists for the order (then nothing is created) or the delivery already exists.

The offer loop takes `searching` deliveries with `next_offer_at <= now` (`FOR UPDATE SKIP LOCKED`, batch 20) and handles each in its own transaction with the delivery row locked:

1. If `now >= search_deadline` or `offers_made >= MAX_OFFERS` (5): status `failed`, emit `delivery.failed`.
2. Otherwise pick one candidate from `CourierView`: `status = 'available'`; position present and `position_at > now − POSITION_MAX_AGE` (120 s); within `OFFER_RADIUS_M` (5,000) of the pickup by `ST_DWithin`; no `pending` offer; not the courier of a delivery in `reserving`, `assigned` or `picked_up`; no earlier offer for this delivery. Order by distance to the pickup, then `courier_id`; `LIMIT 1 FOR UPDATE OF courier_view SKIP LOCKED`.
3. No candidate: `next_offer_at = now + OFFER_RETRY` (5 s); `offers_made` unchanged.
4. Candidate: insert a `pending` offer with `expires_at = now + OFFER_TTL` (30 s); delivery `offered`, `offers_made + 1`.

Courier actions (lock order everywhere: delivery row, then offer row, then courier view row):

- **Accept** `POST /offers/{id}/accept`: the offer must be the caller's (`404`). Already `accepted` by the caller → `200` with the delivery. Not `pending` → `409 offer_not_pending`. `now >= expires_at` → `409 offer_expired`, whether or not the sweeper has run. Otherwise offer `accepted`, delivery `reserving` with `courier_id` and `reserve_deadline = now + RESERVE_TIMEOUT` (20 s), emit `delivery.courier_requested`. A unique-index violation on the courier's active delivery maps to `409 courier_busy`.
- **Decline** `POST /offers/{id}/decline`: `pending` → `declined`; delivery `searching`, `next_offer_at = now`.
- **Expiry sweeper**: `pending` offers with `expires_at <= now` → `expired`; delivery `searching`, `next_offer_at = now`.
- A courier sees at most one pending offer (`GET /offers/current`), and only while `now < expires_at`.

### 5.7 Reservation, pickup, delivery (dispatch ⇄ couriers)

- couriers on `delivery.courier_requested`: lock the courier. If derived status is `available`: set `active_delivery_id`, bump `status_version`, emit `courier.reserved` and `courier.status_changed`. If `active_delivery_id` already equals this delivery: emit `courier.reserved` again. Otherwise emit `courier.reservation_rejected` with reason `offline`, `busy` or `suspended`.
- dispatch on `courier.reserved`: if the delivery is `reserving` with that courier → `assigned`, compute `eta_minutes` (5.9), emit `delivery.assigned`. In any other case emit `delivery.courier_released` for that courier and delivery.
- dispatch on `courier.reservation_rejected`: if `reserving` with that courier → `searching`, courier cleared, `next_offer_at = now`. Otherwise no-op.
- Reservation sweeper: `reserving` deliveries with `reserve_deadline <= now` → `searching`, courier cleared, emit `delivery.courier_released`.
- couriers on `delivery.courier_released`, `delivery.unassigned`, `delivery.cancelled`, `delivery.delivered`: if `active_delivery_id` equals the delivery, clear it, bump `status_version`, emit `courier.status_changed`; otherwise change nothing. `delivery.delivered` also records a `delivery` earning of `courier_payout_minor`; `delivery.cancelled` with `courier_was_assigned = true` and a `courier_id` records a `cancellation_compensation` earning of `compensation_minor`. Earnings are recorded for the named courier whether or not the courier was still attached, and at most once per `(courier, delivery, kind)`.
- **Pickup** `POST /deliveries/{id}/pickup`: caller is the delivery's courier, status `assigned` → `picked_up`, emit `delivery.picked_up`. Already `picked_up` by the caller → `200`. Any other status → `409 invalid_state`.
- **Deliver** `POST /deliveries/{id}/deliver`: `picked_up` → `delivered`; `courier_payout_minor = roundHalfUp(COURIER_BASE_MINOR + delivery_fee_minor × COURIER_SHARE_BPS / 10000)`; emit `delivery.delivered`. Already `delivered` by the caller → `200`.
- **Abandon** `POST /deliveries/{id}/abandon`: `assigned` only → `searching`, courier cleared, `next_offer_at = now`, emit `delivery.unassigned`. The abandoning courier is not offered this delivery again. `search_deadline` and `offers_made` keep running.

### 5.8 Cancellation decision (dispatch)

On `order.cancel_requested`, with the delivery row locked (or absent):

| Delivery | Result |
|---|---|
| absent | insert `CancelledOrder` if there is none; emit `delivery.cancelled` (`courier_was_assigned = false`, `sequence = 1`) |
| `searching`, `offered` | `cancelled`; a pending offer becomes `cancelled`; emit `delivery.cancelled` (`courier_was_assigned = false`) |
| `reserving` | `cancelled`; emit `delivery.cancelled` with the `courier_id` and `courier_was_assigned = false` |
| `assigned` | `cancelled`; emit `delivery.cancelled` with the `courier_id`, `courier_was_assigned = true`, `compensation_minor = CANCEL_COMPENSATION_MINOR` |
| `picked_up`, `delivered` | emit `delivery.cancel_rejected` |
| `cancelled` | emit `delivery.cancelled` again with the stored facts |
| `failed` | emit `delivery.failed` again |

Each answer increments the delivery `version`. A pickup and a cancel request racing on one delivery resolve to exactly one of: picked up and cancel rejected, or cancelled and pickup refused with `409`.

### 5.9 ETA and surge (dispatch)

- `eta_minutes` at assignment: `to_pickup = ceil(d(courier, pickup) × 1.3 / speed)`, `to_dropoff = ceil(d(pickup, dropoff) × 1.3 / speed)`, `wait = max(0, ceil(minutes(ready_at − now)))`; `eta = max(to_pickup, wait) + to_dropoff`. Speeds in m/min: bike 250, scooter 400, car 500. Distances from PostGIS in metres.
- Surge loop per zone: `demand` = deliveries in `searching` or `offered`; `supply` = `CourierView` rows `available` in the zone with a fresh position. `demand = 0` → 10000. Else with `r = demand / max(supply, 1)`: `r < 0.5` → 10000; `r < 1` → 12500; `r < 2` → 15000; otherwise 20000 (compare with integer cross-multiplication). When the value differs from the stored one, update it, bump `version`, emit `surge.updated`. orders applies an event only when `sequence > version`.

### 5.10 Messaging rules

- Streams: `ORDERS` (`orders.>`), `DISPATCH` (`dispatch.>`), `COURIERS` (`couriers.>`); file storage, 7-day max age, duplicate window 2 min. Subject is `<service>.<type>`, e.g. `dispatch.delivery.assigned`. Streams and consumers are created idempotently at start-up by the service that publishes or consumes.
- **Relay** (per service): every 200 ms, in one transaction, take `pg_try_advisory_xact_lock`; if not obtained, return. Read up to 100 unpublished rows by `id`; publish each in order with `WithMsgID(event_id)` and a 5 s timeout; stop at the first failure (record `attempts`, `last_error`); mark the published prefix. Back-off after a failed pass: `min(30 s, 200 ms × 2^failures)`.
- Events of one aggregate are inserted into the outbox while that aggregate's row is locked.
- **Consumers**: one durable pull consumer per (consuming service, stream), named `<consumer>-on-<stream>`, `AckExplicit`, `AckWait` 30 s, no server-side `MaxDeliver` (the delivery limit of 8 is applied by the handler below), filter subjects limited to the types it handles. One goroutine per consumer fetches up to 32 messages and handles them one at a time in order.
- Handling one message: decode and validate the envelope (invalid → dead letter, ack). In one transaction insert into `inbox`; if the row already exists, commit and ack. Run the handler in that transaction; commit; ack. On error roll back; if `NumDelivered >= 8` write a `dead_letters` row and ack, else `NakWithDelay(min(30 s, 1 s × 2^(NumDelivered−1)))`.
- `POST /ops/dead-letters/{id}/replay` runs the handler again through the same inbox path and sets `replayed_at` on success.
- Published outbox rows older than 72 h and inbox rows older than 14 days are purged hourly.

## 6. API and event surface

### HTTP

| Service | Method & path | Notes |
|---|---|---|
| orders | `GET /restaurants` | active only |
| orders | `POST /quotes` | 5.1 |
| orders | `POST /orders`, `GET /orders/{id}`, `GET /orders?status=` | list is scoped by role |
| orders | `POST /orders/{id}/confirm`, `/reject` | restaurant, ops |
| orders | `POST /orders/{id}/cancel` | 5.3 |
| couriers | `POST /couriers` (ops), `GET /couriers/me`, `GET /couriers/{id}` (ops) | |
| couriers | `POST /couriers/me/shift/start`, `/shift/end`, `POST /couriers/me/location` | 5.4 |
| couriers | `POST /couriers/{id}/suspend`, `/reinstate` | ops |
| couriers | `GET /couriers/me/earnings`, `GET /couriers/{id}/earnings` | |
| dispatch | `GET /offers/current`, `POST /offers/{id}/accept`, `/decline` | 5.6 |
| dispatch | `GET /deliveries/{id}`, `POST /deliveries/{id}/pickup`, `/deliver`, `/abandon` | 5.7 |
| dispatch | `GET /zones/{zone_id}/surge` | ops |
| all | `GET /ops/dead-letters`, `POST /ops/dead-letters/{id}/replay`, `GET /ops/outbox/stats` | ops |
| all | `GET /healthz` | no auth |

Error codes beyond those named above: `validation_failed`, `unauthenticated`, `forbidden`, `not_found`, `invalid_state`, `internal_error`.

### Events

Envelope per CONVENTIONS §12.4 in `snake_case`. `aggregate_id` for `delivery.*` is the delivery id, which equals the order id. Coordinates are `{ "lon": float, "lat": float }`.

| Subject (`<stream prefix>.` + type) | `sequence` | `data` | Consumed by |
|---|---|---|---|
| `orders.order.confirmed` | order `version` | `order_id`, `restaurant_id`, `zone_id`, `pickup`, `dropoff`, `ready_at`, `delivery_fee_minor`, `surge_bps`, `currency` | dispatch |
| `orders.order.cancel_requested` | order `version` | `order_id`, `requested_by` (`customer` \| `restaurant` \| `ops`), `attempt` | dispatch |
| `orders.order.cancelled` | order `version` | `order_id`, `reason`, `cancellation_fee_minor`, `refund_minor`, `currency` | none |
| `dispatch.delivery.courier_requested` | delivery `version` | `delivery_id`, `courier_id`, `reserve_deadline` | couriers |
| `dispatch.delivery.courier_released` | delivery `version` | `delivery_id`, `courier_id`, `reason` (`reserve_timeout` \| `not_reserving`) | couriers |
| `dispatch.delivery.assigned` | delivery `version` | `delivery_id`, `courier_id`, `eta_minutes` | orders |
| `dispatch.delivery.unassigned` | delivery `version` | `delivery_id`, `courier_id`, `reason` (`abandoned`) | orders, couriers |
| `dispatch.delivery.picked_up` | delivery `version` | `delivery_id`, `courier_id`, `picked_up_at` | orders |
| `dispatch.delivery.delivered` | delivery `version` | `delivery_id`, `courier_id`, `delivered_at`, `courier_payout_minor`, `currency` | orders, couriers |
| `dispatch.delivery.cancelled` | delivery `version` | `delivery_id`, `courier_id?`, `courier_was_assigned`, `compensation_minor`, `currency` | orders, couriers |
| `dispatch.delivery.cancel_rejected` | delivery `version` | `delivery_id`, `reason` (`picked_up` \| `delivered`) | orders |
| `dispatch.delivery.failed` | delivery `version` | `delivery_id`, `reason` (`no_courier`), `offers_made` | orders |
| `dispatch.surge.updated` | zone `version` | `zone_id`, `multiplier_bps` | orders |
| `couriers.courier.status_changed` | `status_version` | `courier_id`, `status`, `zone_id?`, `vehicle`, `suspended` | dispatch |
| `couriers.courier.location_updated` | `position_seq` | `courier_id`, `lon`, `lat`, `recorded_at` | dispatch |
| `couriers.courier.reserved` | `status_version` | `courier_id`, `delivery_id` | dispatch |
| `couriers.courier.reservation_rejected` | `status_version` | `courier_id`, `delivery_id`, `reason` | dispatch |

## 7. Loops and consumers

Each loop has `RunOnce(ctx, now)`; loops are off when `LOOPS_ENABLED=false`.

| Loop | Service | Interval | Behaviour and failure semantics |
|---|---|---|---|
| Outbox relay | all | 200 ms | 5.10 |
| Confirm sweeper | orders | 5 s | `placed` orders with `confirm_deadline <= now`, `SKIP LOCKED`, batch 100; each cancelled in its own transaction after re-checking status |
| Cancel-request retry | orders | 30 s | 5.3 |
| Offer loop | dispatch | 1 s | 5.6; one delivery's failure is logged and does not stop the batch |
| Offer expiry sweeper | dispatch | 1 s | 5.6; re-checks `pending` and `expires_at <= now` under the locks |
| Reservation sweeper | dispatch | 2 s | 5.7 |
| Surge loop | dispatch | 30 s | 5.9; one transaction per zone |
| Purge | all | hourly | 5.10 |

| Consumer | Handles |
|---|---|
| `dispatch-on-ORDERS` | `order.confirmed`, `order.cancel_requested` |
| `dispatch-on-COURIERS` | `courier.status_changed`, `courier.location_updated`, `courier.reserved`, `courier.reservation_rejected` |
| `orders-on-DISPATCH` | `delivery.assigned`, `.unassigned`, `.picked_up`, `.delivered`, `.cancelled`, `.cancel_rejected`, `.failed`, `surge.updated` |
| `couriers-on-DISPATCH` | `delivery.courier_requested`, `.courier_released`, `.unassigned`, `.delivered`, `.cancelled` |

Retry and dead-letter behaviour for all consumers is in 5.10. Shutdown on `SIGTERM`: stop HTTP, stop fetching, finish the message in hand, stop loops after the current pass, close NATS and pools.

## 8. Edge cases

1. The same event delivered twice, sequentially or to two instances at once, has the effect of one delivery.
2. A handler that fails after writing leaves no partial effect and no inbox row; the redelivery applies it.
3. A message that fails eight times is in `dead_letters`, acknowledged, and later messages are processed; replaying it after the cause is fixed applies it once.
4. `order.cancel_requested` arriving before `order.confirmed`: no delivery is ever created; orders ends `cancelled` with no fee.
5. `delivery.picked_up` arriving at orders before `delivery.assigned`: the order becomes `picked_up` with the courier set; the late `assigned` changes nothing.
6. `delivery.unassigned` (sequence 6) redelivered after `delivery.assigned` (sequence 8) was applied: ignored.
7. Any `delivery.*` event for a `delivered` or `cancelled` order changes nothing.
8. `courier.status_changed` version 4 arriving after version 5: ignored. A location with an older `recorded_at` than the stored one: ignored.
9. A location event for a courier dispatch has not seen creates an `offline` row that is never offered work.
10. Two deliveries searching at once near one courier: the courier gets one pending offer; the other delivery picks someone else or waits.
11. A courier with a pending offer, or in `reserving`/`assigned`/`picked_up`, is never a candidate.
12. A courier whose last position is 121 s old is not a candidate; 119 s is.
13. A courier 5,001 m from the pickup is not a candidate; the nearest of several is chosen, ties by id.
14. A courier who declined, let expire, or abandoned a delivery is not offered it again.
15. Accept at exactly `expires_at` is `409 offer_expired` even when the sweeper has not run; one millisecond earlier succeeds.
16. Accept and the expiry sweeper racing on one offer: either accepted (delivery `reserving`) or expired (delivery `searching`), never both.
17. A courier double-tapping accept gets two `200`s and one reservation request.
18. A courier accepting an offer that was cancelled because the order was cancelled gets `409 offer_not_pending`.
19. A courier who went off shift between offer and accept: accept succeeds at dispatch, couriers rejects the reservation, the delivery returns to `searching` and no `delivery.assigned` reaches orders.
20. `courier.reserved` arriving after the reservation deadline moved the delivery on: the courier is released again and ends `available`.
21. `delivery.courier_released` processed by couriers before `delivery.courier_requested`: the courier still ends unattached.
22. A courier going `offline` with a pending offer: the offer is cancelled and the delivery searches again immediately.
23. Five offers without an acceptance, or ten minutes without assignment, ends the delivery `failed` and the order `cancelled` with `no_courier` and a full refund.
24. No courier in range does not consume an offer attempt.
25. Cancel while `searching`: order cancelled, fee 0. Cancel while `assigned`: fee charged to the customer, compensation earned by the courier, courier released.
26. Cancel while `reserving`: no fee, no compensation, and the courier ends unattached whichever of the reservation and the cancellation couriers processes first.
27. Cancel request and pickup at the same instant: one consistent outcome across all three services.
28. A cancel request rejected because of pickup leaves the order `picked_up`; it is later `delivered` normally.
29. A second cancel call while one is pending returns `202` and emits nothing; a lost answer is covered by the retry sweeper, and a repeated request to dispatch produces the same answer.
30. Restaurant or ops cancellation of an assigned order: no customer fee; the courier is still compensated.
31. Confirm at exactly `confirm_deadline` is refused; the order is cancelled with `confirm_timeout` by the sweeper and never reaches dispatch.
32. Confirm and the confirm sweeper racing: one wins.
33. Two `POST /orders` with the same `client_order_key` (sequential or concurrent) create one order; the same key with another quote is `422`.
34. One quote used by two concurrent requests with different keys: one order.
35. A customer at the active-order limit sending two more orders concurrently gets at most the limit; a delivered or cancelled order frees a slot.
36. Surge rising between quote and order does not change the order's fee; an expired quote is refused.
37. Fee rounding: `BASE 199`, `PER_KM 60`, 2,345 m, surge 12500 → 425.
38. Surge tiers at the boundaries: demand 1 / supply 2 → 12500; 2/2 → 15000; 4/2 → 20000; demand with zero supply uses supply 1.
39. An older `surge.updated` arriving after a newer one is ignored by orders.
40. Location pings 4 s apart with no movement publish one event; a ping 60 m away publishes at once; a ping stamped 31 s ahead is `422`; a ping 6 min old is accepted and not stored.
41. Ending a shift during an active delivery is `409`; suspending a courier mid-delivery lets them finish, pays them, and leaves them `offline`.
42. `delivery.delivered` handled twice by couriers records one earning; a compensation and a delivery earning for different deliveries coexist.
43. Pickup by a courier who is not the delivery's courier is `404`; pickup while `reserving` is `409`.
44. Deliver before pickup is `409`; deliver twice returns `200` and emits one event.
45. Abandon after pickup is `409`; abandon while `assigned` sends the order back to `confirmed` and a different courier is found.
46. NATS down: HTTP writes succeed in every service; when it returns, outbox rows are published in id order.
47. Relay crash between publish and mark: the event is published again with the same id and has no second effect.
48. Two instances of a service: one relay publishes at a time; offer loops do not offer one delivery twice.
49. ETA when the courier arrives before the food is ready uses the wait; when the food is ready first it uses travel time.

## 9. Non-goals

Payments, real refunds, menus and catalogue, customer and courier registration, identity service, maps and routing, batching several orders per courier, scheduled orders, tipping, ratings, push notifications, courier location history, UI, an API gateway, distributed tracing.

## 10. Acceptance criteria

- A courier is never the courier of two live deliveries and never has two pending offers; a delivery never has two pending offers or two couriers.
- Each service reaches the same final outcome for every order under duplicated, delayed and reordered events.
- Every state change that other services need is in the outbox in the same transaction; no handler publishes directly.
- A cancellation ends in exactly one of cancelled-with-compensation-settled or rejected, in all three services.
- Timeouts (confirm, offer, reservation, search) take effect at their instants regardless of sweeper timing.
- All edge cases in section 8 hold.

## 11. Required tests

Unit (pure):
- Fee and payout rounding; ETA; surge tiers; quote expiry; status derivation for couriers; location publish decision.
- Order transition table and delivery-event application by sequence.
- Cancellation decision table (5.8) and fee rules (5.3).
- Envelope validation; consumer back-off schedule; relay back-off.

Integration per service (real database, handlers called with envelopes, fixed clock):
- orders: quote and placement, idempotent placement (sequential and concurrent), quote single use, active-order limit under concurrency, confirm deadline and sweeper, each `delivery.*` event in and out of order, cancel flows and retry sweeper, permissions.
- dispatch: candidate selection (freshness, radius, exclusions, ordering), concurrent offer loops over two deliveries and one courier, accept/decline/expiry and their races, reservation confirm/reject/timeout, pickup/deliver/abandon, cancellation decision for every status, pickup vs cancel race, projection ordering, surge loop, permissions.
- couriers: shift rules, suspension with active delivery, location storage and publish throttling, reservation handling in both orders of arrival, release handling, earnings uniqueness, permissions.
- pkg: inbox dedupe including concurrent duplicates; handler failure rolls back the inbox row; dead-lettering at the delivery limit and replay; relay order, stop on failure, resume; two relays.

End to end (`test/e2e`, three services, real NATS): happy path to `delivered`; no courier → cancelled; cancel while assigned; courier off shift before reservation; NATS-backed duplicate delivery of one event.

## 12. Commit plan

1. `chore`: module, `pkg` foundations (config, logging, clock, idgen, httpx envelope, auth), compose with init scripts, `.env.example`.
2. `feat`: `pkg` messaging: envelope, outbox relay, inbox, consumer runner, dead letters, with tests.
3. `feat(orders)`: migrations, sqlc queries and output, restaurants, quotes and fee calculation.
4. `feat(orders)`: order placement, confirm/reject, confirm sweeper, `order.confirmed`.
5. `feat(couriers)`: migrations, sqlc, courier profiles, shifts, suspension, status events.
6. `feat(couriers)`: location pings and throttled location events.
7. `feat(dispatch)`: migrations, sqlc, courier projection consumer, delivery creation from `order.confirmed`.
8. `feat(dispatch)`: offer loop with nearest-courier query, accept/decline, expiry sweeper.
9. `feat`: reservation handshake between dispatch and couriers, reservation sweeper, releases.
10. `feat`: pickup, deliver, abandon; order status projection in orders; courier earnings.
11. `feat`: cancellation saga across the three services with retry sweeper.
12. `feat(dispatch)`: ETA and surge loop; surge projection in orders.
13. `test`: end-to-end suite, concurrency suites, ops endpoints for dead letters and outbox stats.
14. `docs`/`ci`: seeds, `devtoken`, README, CI workflow.
