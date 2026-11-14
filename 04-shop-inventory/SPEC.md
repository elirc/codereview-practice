# 04 — Shop Inventory and Orders

## 1. Purpose

Back office and order API for a small single-currency shop: products, stock, orders with stock reservation, payments confirmed by a payment-provider webhook, and full or partial refunds. API only, plus Django admin for read-only inspection. Read `../CONVENTIONS.md` first.

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Runtime | Python 3.12, Django 5.1.4, djangorestframework 3.15.2 |
| DB | PostgreSQL 16 (compose host port 5454), psycopg 3.2.3 |
| Jobs | Celery 5.4.0 with Redis 7 as broker (`redis` 5.2.1; compose host port 6384). Celery beat for periodic tasks. No result backend |
| Config | django-environ 0.11.2 |
| Logging | structlog 24.4.0 + django-structlog 9.0.0 (request id middleware, Celery signal integration) |
| Tests | pytest 8.3.4, pytest-django 4.9.0, factory-boy 3.3.1; `CELERY_TASK_ALWAYS_EAGER` is **not** used for webhook/refund tests — tasks are called directly as functions; concurrency tests use `transaction=True` and threads |
| Lint | Ruff 0.8.4 |
| Auth | Staff: DRF `TokenAuthentication` (`rest_framework.authtoken`), tokens issued by `POST /api/auth/token/`. Storefront endpoints are anonymous. Webhook is authenticated by signature only |

Layout: `config/` (settings, urls, celery), apps `catalog`, `inventory`, `orders`, `payments`, `core` (errors, idempotency, permissions). Business logic lives in `services.py` modules per app; views and tasks are thin. Payment provider behind `payments/provider.py` (`PaymentProvider` protocol, `FakeProvider` for dev/tests chosen by setting).

Shop currency from env `SHOP_CURRENCY` (default `USD`); all amounts are integer minor units (`BigIntegerField`).

## 3. Roles and permissions

Staff users have Django group `manager` or `clerk`.

| Action | anonymous | clerk | manager |
|---|---|---|---|
| List/read active products with availability | yes | yes | yes |
| Create order (checkout), read order by `public_token` | yes | yes | yes |
| List/read all orders | no | yes | yes |
| Cancel unpaid order, mark paid order fulfilled | no | yes | yes |
| Create/edit products | no | no | yes |
| Receive stock | no | yes | yes |
| Adjust stock (± with reason) | no | no | yes |
| Create refund | no | up to `CLERK_REFUND_LIMIT_MINOR` (default 5000) per refund | yes |
| View stock movements, webhook events | no | yes | yes |

## 4. Domain model

- **Product**: `sku` (unique), `name`, `price_minor` (> 0), `active`.
- **StockItem** (one per product): `on_hand`, `reserved`. DB checks: `on_hand >= 0`, `reserved >= 0`, `reserved <= on_hand`. `available = on_hand - reserved`.
- **StockMovement** (append-only): `product`, `kind` (`receive` | `adjust` | `reserve` | `release` | `commit` | `restock`), `on_hand_delta`, `reserved_delta`, `order?`, `refund?`, `reason`, `actor?`, `created_at`. Invariant: for each product, sums of the deltas equal the StockItem columns.
- **Order**: `number` (human id from a DB sequence, `SO-000123`), `public_token` (random 32 bytes urlsafe), `email`, `status`, `total_minor`, `currency`, `payment_intent_id` (unique, from provider), `reservation_expires_at`, `paid_at?`, `amount_paid_minor` (default 0), `last_payment_event_at?`, `needs_review` (bool), `review_reason`, timestamps.
- **OrderLine**: `order`, `product`, `sku` and `name` snapshots, `unit_price_minor` snapshot, `quantity` (> 0), `refunded_quantity` (succeeded refunds only).
- **Refund**: `id` (UUID), `order`, `amount_minor` (> 0), `status` (`pending` | `succeeded` | `failed`), `reason`, `provider_refund_id?` (unique when set), `source` (`staff` | `system` | `provider`), `created_by?`, `failure_reason`, timestamps.
- **RefundLine**: `refund`, `order_line`, `quantity` (> 0), `restock` (bool).
- **WebhookEvent**: `provider_event_id` (unique), `type`, `payload` (JSON), `provider_created_at`, `status` (`received` | `processed` | `ignored` | `failed`), `attempts`, `last_error`, `received_at`, `processed_at?`.
- **IdempotencyRecord**: `key`, `scope` (endpoint name), `request_hash`, `response_status`, `response_body`, `created_at`; unique `(scope, key)`.

Order statuses: `pending_payment`, `paid`, `fulfilled`, `cancelled`, `expired`. Refund progress is derived: `refunded_minor` = sum of succeeded refunds; `refund_state` ∈ `none` | `partial` | `full`.

## 5. Domain rules

### 5.1 Stock

- Every change to `StockItem` happens in a transaction holding `select_for_update()` on the row and writes a `StockMovement` in the same transaction. When several products are involved, rows are locked in ascending product id order.
- Receive: `on_hand += n` (n > 0). Adjust: `on_hand += delta`; refused with `422 adjustment_below_reserved` if the result would be less than `reserved`.
- Counter arithmetic is done on locked, freshly read rows (or `F()` expressions); values read before the lock are never written back.

### 5.2 Checkout

`POST /api/orders/` with `{ email, lines: [{ sku, quantity }] }` and required `Idempotency-Key`.

1. Lines with a duplicate SKU are merged. 1–50 distinct lines, quantity 1–999. Unknown or inactive SKU → `422 unknown_product`.
2. In one transaction: lock stock rows; if any line has `available < quantity`, fail the whole order with `409 insufficient_stock` and `details.lines: [{ sku, requested, available }]` for every short line; nothing is reserved.
3. `reserved += quantity` per line with `reserve` movements; create order with snapshots, `total_minor = Σ unit_price × quantity`, `status = pending_payment`, `reservation_expires_at = now + RESERVATION_MINUTES` (default 30).
4. After commit, call `provider.create_payment_intent(order)` and store `payment_intent_id`. If the provider call fails, cancel the order (releasing stock) and return `502 payment_provider_unavailable`.
5. Response `201` with order, `public_token`, and the provider's `client_secret`.

### 5.3 Order transitions

| From | To | Trigger |
|---|---|---|
| `pending_payment` | `paid` | `payment.succeeded` event |
| `pending_payment` | `cancelled` | staff cancel |
| `pending_payment` | `expired` | expiry task, when `reservation_expires_at <= now` |
| `expired` / `cancelled` | `paid` | late `payment.succeeded`, only if stock can be re-acquired (5.5) |
| `paid` | `fulfilled` | staff |

All transitions lock the order row (`select_for_update`) and re-check status under the lock. Lock order is always order row first, then stock rows.

- Becoming `paid` from `pending_payment`: per line `on_hand -= qty`, `reserved -= qty` (`commit` movement); set `paid_at`, `amount_paid_minor`.
- `cancelled` / `expired`: per line `reserved -= qty` (`release` movement).
- Staff cannot cancel a `paid` order; they refund it.

### 5.4 Webhook endpoint

`POST /webhooks/payments/` — no session/token auth, CSRF exempt, raw body required.

Signature: header `X-Pay-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…]`. Expected value is `HMAC-SHA256(secret, f"{t}.".encode() + raw_body)` hex. Secrets: `PAYMENT_WEBHOOK_SECRET` and optional `PAYMENT_WEBHOOK_SECRET_PREVIOUS` (rotation); the request is valid if any `v1` matches either secret, compared with `hmac.compare_digest`. `|now - t| <= 300` seconds. The signature is verified over the exact bytes received, before any JSON parsing.

Responses:
- Missing/malformed header, bad signature, or timestamp outside tolerance → `400 invalid_signature`; nothing is stored.
- Valid signature but body not JSON or missing `id`/`type`/`created`/`data` → `400 invalid_payload`.
- Otherwise insert `WebhookEvent` (`received`). On unique violation of `provider_event_id` the event is a duplicate delivery: respond `200 {"status": "duplicate"}`; if the existing row is still `received` or `failed`, re-enqueue processing, otherwise do nothing.
- New event: enqueue `process_webhook_event` with `transaction.on_commit`, respond `200 {"status": "accepted"}`. The endpoint never processes inline and never returns an error because of processing problems.
- Unknown `type` is stored and later marked `ignored`.

Event payload: `{ "id": "evt_…", "type": "...", "created": <unix>, "data": { "payment_intent_id": "...", "amount_minor": n, "currency": "USD", "refund_id"?: "...", "refund_reference"?: "...", "failure_reason"?: "..." } }`. `refund_id` is the provider's refund id; `refund_reference` echoes the idempotency key we sent when creating the refund (absent for refunds issued in the provider dashboard).

"Idempotent" here means: delivering the same `provider_event_id` any number of times, concurrently or not, changes order, stock, payment and refund state exactly as a single delivery would, and processing the same stored event more than once (task retry, redelivery) has no further effect once it is `processed` or `ignored`.

### 5.5 Event processing

`process_webhook_event(event_id)`, in one transaction: lock the event row; if `processed` or `ignored`, return. Dispatch by type; on success set `processed`/`ignored`, `processed_at`. State changes and the event status commit together.

**payment.succeeded**
- Order looked up by `payment_intent_id`; not found → raise retryable error (5.7).
- Currency mismatch or `amount_minor != order.total_minor` → order `needs_review = true` with reason; no status change; event `processed`.
- Order `pending_payment` → pay (5.3), even if `reservation_expires_at` has passed but the expiry task has not yet run.
- Order `expired` or `cancelled` with `amount_paid_minor > 0` (a late payment was already recorded and is being or has been refunded) → no change (`ignored`).
- Order `expired` or `cancelled` otherwise → try to re-acquire: lock stock rows; if every line has `available >= qty`, `on_hand -= qty` directly (movement `commit`, `reserved_delta = 0`) and set `paid`. Otherwise record `amount_paid_minor`, leave the status, and create a full system refund (5.6, `reason = stock_unavailable`).
- Order already `paid`/`fulfilled` → no change (`ignored`).
- Set `last_payment_event_at = max(existing, provider_created_at)`.

**payment.failed**
- Ignored if order is not `pending_payment`, or if `provider_created_at <= last_payment_event_at`.
- Otherwise record `last_payment_event_at` and failure reason on the order; the order stays `pending_payment` (customer may retry) until expiry.

**refund.succeeded / refund.failed**
- Refund looked up by `provider_refund_id = data.refund_id`, else by `data.refund_reference` (our Refund UUID); in the second case `provider_refund_id` is filled in.
- Found and `pending`: on success set `succeeded`, add quantities to `OrderLine.refunded_quantity`, restock lines flagged `restock` (`on_hand += qty`, `restock` movement); on failure set `failed` with reason (its claim on refundable amount and quantities is released by virtue of status).
- Found and already terminal: if the event agrees with the status, `ignored`. A `refund.failed` arriving after `succeeded` (or the reverse) → `needs_review`, no state change.
- Not found, `refund.succeeded`: refund was issued in the provider dashboard. Create a `Refund` (`source = provider`, `succeeded`, no lines, no restock) if the amount fits within what is still refundable, counting pending as well as succeeded refunds: `Σ amount of refunds in (pending, succeeded) + amount <= amount_paid_minor`. Otherwise set `needs_review` and create nothing.
- Not found, `refund.failed`: `ignored`.

### 5.6 Refunds

`POST /api/orders/{number}/refunds/` with required `Idempotency-Key` and exactly one of:
- `lines: [{ order_line_id, quantity, restock }]` — amount is `Σ unit_price_minor × quantity`; or
- `amount_minor` (goodwill, no lines, no restock).

Plus `reason` (required, 1–200).

Under the order row lock:
- Order must be `paid` or `fulfilled` (`409 invalid_state`).
- `amount <= amount_paid_minor − Σ amount of refunds in (pending, succeeded)` else `422 exceeds_refundable` with `details.refundable_minor`.
- Per line: `quantity <= line.quantity − line.refunded_quantity − Σ pending refund-line quantity` else `422 exceeds_refundable_quantity`. Lines must belong to this order (`422 invalid_line`).
- Clerk limit applies to this refund's amount (`403 refund_limit_exceeded`).
- Create `Refund` `pending`; enqueue `submit_refund(refund_id)` on commit; respond `202` with the refund.

`submit_refund` calls `provider.create_refund(payment_intent_id, amount_minor, idempotency_key=str(refund.id))` and stores `provider_refund_id`. It does **not** mark the refund succeeded; only the webhook does. Restock happens only when the refund succeeds.

### 5.7 Request idempotency (staff/storefront)

For `POST /api/orders/` and refund creation: `Idempotency-Key` header, 8–128 chars. `request_hash` = SHA-256 of the canonical JSON body. Within a transaction, insert the `IdempotencyRecord` first (unique constraint serialises concurrent duplicates; the loser waits, then replays). Same key + same hash → stored status and body are returned. Same key + different hash → `422 idempotency_key_reused`. Only `2xx` and `4xx` business outcomes are stored; a `5xx` rolls back the record so the client can retry. Missing header → `400 idempotency_key_required`.

## 6. API surface

Prefix `/api/`. `snake_case` JSON. DRF pagination: `LimitOffsetPagination` (default 50, max 200). A custom DRF exception handler produces the error envelope.

| Method & path | Notes |
|---|---|
| `POST /auth/token/` | username + password → token |
| `GET /products/`, `GET /products/{sku}/` | Anonymous sees active only; includes `available` |
| `POST /products/`, `PATCH /products/{sku}/` | manager. Price change does not affect existing orders |
| `POST /products/{sku}/stock/receive/` | `{ quantity, reason }` |
| `POST /products/{sku}/stock/adjust/` | `{ delta, reason }` manager |
| `GET /products/{sku}/stock/movements/` | staff |
| `POST /orders/` | 5.2 |
| `GET /orders/` | staff; filters `status`, `needs_review`, `email` |
| `GET /orders/{number}/` | staff, or anonymous with `?token=<public_token>` (constant-time compare; mismatch → `404`) |
| `POST /orders/{number}/cancel/`, `POST /orders/{number}/fulfil/` | staff |
| `GET /orders/{number}/refunds/`, `POST /orders/{number}/refunds/` | staff; 5.6 |
| `GET /webhook-events/`, `GET /webhook-events/{id}/` | staff; payload shown, signature never stored |
| `POST /webhook-events/{id}/retry/` | manager; only for `failed`; re-enqueues |
| `POST /webhooks/payments/` | 5.4 (outside `/api/`) |

A dev-only management command `simulate_webhook <type> <order_number> [--event-id …] [--created …]` builds, signs and posts an event, for manual testing.

## 7. Background jobs

Celery settings: `task_acks_late = True`, `task_reject_on_worker_lost = True`, `worker_prefetch_multiplier = 1`, JSON serialisation, tasks take ids only.

| Task | Trigger | Retry and failure semantics |
|---|---|---|
| `payments.process_webhook_event` | webhook endpoint, manual retry | Retryable errors (`OrderNotFoundYet`, `OperationalError`/deadlock/serialisation failure): `self.retry` with exponential backoff 2^n × 5 s capped at 10 min, `max_retries = 6`; each attempt increments `attempts` and stores `last_error` in a separate small transaction. After retries are exhausted, or on any non-retryable exception, the event is marked `failed` and the error is logged. The business transaction is all-or-nothing per attempt |
| `payments.submit_refund` | refund creation | Loads refund; if not `pending` or `provider_refund_id` already set, return. `ProviderTransientError` → retry with backoff, `max_retries = 5`; the same idempotency key is sent on every attempt. `ProviderPermanentError` or exhausted retries → refund `failed` with reason (under order lock) |
| `orders.expire_reservations` | beat, every minute | Selects ids of `pending_payment` orders with `reservation_expires_at <= now` (batch 200), then expires each in its own transaction, re-checking status and expiry under the order lock; one order's failure is logged and does not stop the batch |
| `payments.requeue_stale_events` | beat, every 5 minutes | Re-enqueues events still `received` 5 minutes after `received_at`, and re-enqueues `submit_refund` for refunds still `pending` with no `provider_refund_id` 5 minutes after creation. Both cover a lost broker message; both target tasks are idempotent, so a redundant enqueue has no effect |

## 8. Edge cases

1. Two concurrent checkouts for the last unit: one `201`, one `409 insufficient_stock`; `reserved` ends at 1.
2. Checkout with two lines where only the second is short reserves nothing.
3. Two concurrent checkouts for products {A, B} and {B, A} do not deadlock.
4. Concurrent `receive` and checkout on one product: final counters equal the serial result; movement sums equal counters.
5. Adjust that would bring `on_hand` below `reserved` is refused.
6. Same `Idempotency-Key` and body sent twice (sequentially and concurrently) creates one order and reserves once; second response equals the first.
7. Same key with a different body → `422`.
8. Webhook with valid signature computed over re-serialised JSON (different whitespace) than the bytes sent → rejected.
9. Signature valid for the previous secret is accepted when `…_PREVIOUS` is set.
10. Timestamp 301 seconds old → rejected; 300 → accepted. A future timestamp beyond tolerance is rejected too.
11. Header with several `v1` values, one valid → accepted. Missing `t` → rejected.
12. Same event delivered twice concurrently: one row, order paid once, stock committed once.
13. Event redelivered after being `processed`: `200 duplicate`, no task enqueued.
14. Task executed twice for one event (broker redelivery after worker crash): second run is a no-op.
15. Worker crash mid-processing: the transaction rolled back, event stays `received`, redelivery completes it.
16. `payment.succeeded` for an order whose `reservation_expires_at` passed but still `pending_payment` → paid normally.
17. `payment.succeeded` after expiry with stock still available → `paid`, `on_hand` reduced, `reserved` untouched.
18. `payment.succeeded` after expiry with stock gone → status stays `expired`, full system refund created and submitted, no negative stock.
19. Expiry task and `payment.succeeded` racing on one order: outcomes are either (paid) or (expired then case 17/18); stock is never released twice or committed twice.
20. `payment.failed` (created at T1) processed after `payment.succeeded` (created at T2 > T1) → ignored; order stays `paid`.
21. `payment.succeeded` with wrong amount or currency → `needs_review`, not paid, stock still reserved until expiry.
22. `payment.succeeded` for unknown `payment_intent_id` → retried, then `failed`; endpoint still returned `200`.
23. Two concurrent refund requests that together exceed the refundable amount: one `202`, one `422`.
24. Refund quantity counts pending refunds: with 3 units, a pending refund of 2 allows at most 1 more.
25. A `failed` refund frees its amount and quantities for a new refund.
26. Refund with `restock: true` returns stock only when `refund.succeeded` is processed, and only once.
27. `refund.succeeded` arriving before `submit_refund` has stored `provider_refund_id` is matched via `refund_reference`.
28. `refund.succeeded` for a dashboard-issued refund creates a provider-sourced refund; if it would exceed the amount paid → `needs_review`.
29. `refund.failed` after `refund.succeeded` for the same refund → `needs_review`, no stock change.
30. `submit_refund` retried after a timeout where the provider did create the refund: same idempotency key, one provider refund.
31. Clerk refund over the limit → `403`; exactly at the limit → allowed.
32. Full refund of an order via two partial refunds yields `refund_state = full`; a further refund → `422 exceeds_refundable`.
33. Anonymous order read with a wrong token → `404`.
34. Product price change after checkout does not change the order total or refund amounts.
35. Cancelling an order twice, or cancelling while it is being paid: one transition wins; stock released at most once.
36. A dashboard-issued `refund.succeeded` arriving while a staff refund is still pending, where the two together exceed the amount paid → `needs_review`, no provider-sourced refund is recorded, and the pending refund is unaffected.
37. A refund whose `submit_refund` message was never delivered to the broker is picked up by the requeue task and submitted; a refund that already has a `provider_refund_id`, or is no longer `pending`, is not re-enqueued.
38. A second `payment.succeeded` (new event id) for an expired or cancelled order whose earlier late payment was already recorded and refunded is `ignored`: no stock is taken and no second refund is created, even if stock has since returned.

## 9. Non-goals

Customer accounts, carts, shipping, tax, discounts, multi-currency, multi-warehouse, backorders, real provider SDK, storefront UI, emails.

## 10. Acceptance criteria

- For every product at all times: `0 <= reserved <= on_hand`, and movement sums equal the counters.
- An order is paid at most once; stock is committed at most once per order; a refund restocks at most once.
- Webhook handling is idempotent as defined in 5.4 and tolerant of the orderings in section 8.
- Refund totals can never exceed the amount paid, under concurrency.
- All edge cases in section 8 hold.

## 11. Required tests

Unit:
- Signature verification: valid, wrong secret, previous secret, tolerance boundaries, malformed header, multiple `v1`, body byte-exactness.
- Refund amount/quantity calculation including pending refunds; clerk limit boundary.
- Request-hash canonicalisation.

Integration (`pytest.mark.django_db`; concurrency tests with `transaction=True` and threads + a barrier):
- Checkout: success, all-or-nothing shortage, duplicate SKU merge, concurrent last unit, opposite lock order.
- Idempotency records: replay, mismatch, concurrent duplicates, `5xx` not stored.
- Stock ledger invariant after a mixed sequence of operations.
- Webhook endpoint: each rejection path stores nothing; duplicate delivery; unknown type.
- Event processing: every branch of 5.5, including the out-of-order and late-payment cases, double processing, and retry exhaustion marking `failed`.
- Expiry: releases stock once; skips orders paid in the meantime; race with payment.
- Refunds: over-refund prevention (sequential and concurrent), restock on success only, failed refund frees capacity, provider-sourced refund (including one that collides with a pending refund), `submit_refund` retry behaviour with a provider fake that fails transiently, permanent failure, requeue of unsubmitted refunds.
- Permissions matrix for staff roles and anonymous access; order token access.

## 12. Commit plan

1. `chore`: project scaffold (settings via environ, structlog, Celery app, error envelope handler, compose, `.env.example`).
2. `feat`: catalog and inventory models, migrations, stock services (receive/adjust) and movements.
3. `feat`: staff auth, groups/permissions, product and stock endpoints with tests.
4. `feat`: orders models, checkout with reservation, request idempotency, provider interface and fake.
5. `feat`: order transitions (cancel, fulfil), expiry task and beat schedule.
6. `feat`: webhook endpoint — signature verification, event store, dedupe.
7. `feat`: event processing task — payment events, late and out-of-order handling.
8. `feat`: refunds — creation rules, `submit_refund`, refund events, restock.
9. `test`: concurrency and ledger-invariant suites.
10. `feat`: admin registrations (read-only), `simulate_webhook` command, stale-event requeue, webhook event endpoints.
11. `docs`/`ci`: seed command, README, CI workflow.
