# Decisions

Short records of places where the spec left room for interpretation.

## Error envelope key casing

The JSON API uses `snake_case`, but the shared error envelope is specified literally as
`{code, message, details, requestId}`. The envelope is kept exactly as specified, so
`requestId` is the one camelCase key in responses.

## Duplicate SKU on product creation

The spec names no error code for this. A duplicate SKU is reported as `400 validation_failed`
with a field error on `sku`, which is what a uniqueness validator would produce; a concurrent
insert that slips past the check is caught at the unique constraint and reported the same way.

## Stock receive reason

`receive` takes `{quantity, reason}` but only adjustments are described as "with reason".
The receive reason is optional (blank allowed); the adjustment reason is required.

## Checkout line limits after merging

"1–50 distinct lines, quantity 1–999" is applied to the merged lines: each submitted line must
have a quantity of 1–999, and after duplicate SKUs are merged there must be at most 50 lines
and no merged quantity above 999. The raw list is capped at 200 entries.

## Which outcomes the idempotency record stores

Schema validation (`400 validation_failed`) and authentication/permission failures happen
before the key is claimed and are not stored, so a client can fix a malformed body and retry
with the same key. Domain outcomes (`2xx` and business `4xx` such as `409 insufficient_stock`
or `403 refund_limit_exceeded`) are stored and replayed; `5xx` outcomes are not stored.

## Waiting for a concurrent duplicate across the checkout's two steps

Checkout commits the reservation before calling the payment provider, so the final response is
only known after a second step. A row lock on the idempotency record cannot span both
transactions, so each idempotent request holds a session-level Postgres advisory lock derived
from `(scope, key)` for its whole duration. A concurrent duplicate waits on that lock and then
replays the stored response. The unique `(scope, key)` constraint is still what guarantees a
single record. A record that is found unfinished while holding the lock belongs to a request
that died mid-way; it is discarded and the request runs again (an order left behind by such a
crash has no payment intent and is released by the expiry task).

## Refund idempotency covers the order number

`(scope, key)` is unique per endpoint, and the refund endpoint is per order. The request hash
for refunds is computed over `{order, body}`, so reusing a key on a different order with the
same body is rejected as `422 idempotency_key_reused` instead of replaying another order's
refund.

## Payments business logic is a package

The spec asks for `services.py` per app. Payments has three distinct areas (webhook intake,
event processing, refunds), so it uses a `payments/services/` package with one module each to
keep files focused. Views and tasks stay thin and call into these modules.

## Where a payment failure reason is kept

`payment.failed` must record "failure reason on the order", but the Order model lists no field
for it. Orders gain `payment_failure_reason` (blank by default), shown to staff.

## Order of checks for `payment.succeeded`

The checks run in the order the spec lists them: an amount or currency mismatch flags the order
for review (event `processed`, no status change) before the order status is considered, so a
mismatched event for an order that is already paid is flagged rather than ignored. A matching
event for a paid or fulfilled order is `ignored`. `paid_at` is the time the event is processed.

## Payment events for an unknown payment intent

Only `payment.succeeded` is specified as retryable when no order carries the payment intent.
`payment.failed` and the refund events look the order up the same way and are retried the same
way, since the most likely cause is the intent id not being stored yet.

## Signature header parsing

The header format is `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`. Parsing is strict about the parts
it understands: an element without `=`, an empty value, a repeated or non-numeric `t`, or no
`v1` at all rejects the request. Elements with other scheme names (for example `v0`) are
ignored. Signatures are compared exactly as lowercase hex, which is what the signer produces.
The timestamp is signed exactly as it appears in the header.

## Manual retry of a failed webhook event

`POST /webhook-events/{id}/retry/` re-enqueues processing and responds `202` with the event; the
event keeps its `failed` status until the task processes it. Retrying an event in any other
status is `409 invalid_state`. Processing treats `failed` like `received`, and processing is
idempotent, so a double retry has no extra effect.

## Dashboard refunds count pending refunds too

The spec checks a provider-issued refund against `refunded_minor` (succeeded refunds only).
A pending staff refund could then also succeed and take the total above the amount paid, so the
check uses pending plus succeeded refunds, the same claim used for staff refunds. A dashboard
refund that does not fit flags the order for review.

## Re-submitting refunds whose publish was lost

Publishing a task never fails the request, so a lost `submit_refund` message would leave a
refund `pending` with no provider id, holding its claim indefinitely. The five-minute
`payments.requeue_stale_events` beat task also re-publishes `submit_refund` for refunds that are
still `pending` with no provider refund id five minutes after creation. Submission is safe to
repeat because the refund id is the provider idempotency key.
