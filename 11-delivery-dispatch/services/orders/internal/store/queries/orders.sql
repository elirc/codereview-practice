-- name: LockCustomer :exec
SELECT pg_advisory_xact_lock(@lock_key::bigint);

-- name: InsertOrder :one
INSERT INTO orders (
    id, customer_id, restaurant_id, zone_id, quote_id, client_order_key, status, items,
    subtotal_minor, delivery_fee_minor, surge_bps, total_minor,
    pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, confirm_deadline,
    version, created_at, updated_at
) VALUES (
    @id, @customer_id, @restaurant_id, @zone_id, @quote_id, @client_order_key, 'placed', @items,
    @subtotal_minor, @delivery_fee_minor, @surge_bps, @total_minor,
    @pickup_lon, @pickup_lat, @dropoff_lon, @dropoff_lat, @confirm_deadline,
    1, @created_at, @created_at
)
RETURNING id, customer_id, restaurant_id, zone_id, quote_id, client_order_key, status, items,
       subtotal_minor, delivery_fee_minor, surge_bps, total_minor,
       pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, confirm_deadline, ready_at,
       courier_id, eta_minutes, delivery_sequence, cancel_request, cancel_requested_by,
       cancel_requested_at, cancel_request_attempts, cancel_retry_at, cancel_note, cancel_reason,
       cancellation_fee_minor, refund_minor, version, created_at, updated_at;

-- name: GetOrder :one
SELECT id, customer_id, restaurant_id, zone_id, quote_id, client_order_key, status, items,
       subtotal_minor, delivery_fee_minor, surge_bps, total_minor,
       pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, confirm_deadline, ready_at,
       courier_id, eta_minutes, delivery_sequence, cancel_request, cancel_requested_by,
       cancel_requested_at, cancel_request_attempts, cancel_retry_at, cancel_note, cancel_reason,
       cancellation_fee_minor, refund_minor, version, created_at, updated_at
FROM orders
WHERE id = @id;

-- name: GetOrderForUpdate :one
SELECT id, customer_id, restaurant_id, zone_id, quote_id, client_order_key, status, items,
       subtotal_minor, delivery_fee_minor, surge_bps, total_minor,
       pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, confirm_deadline, ready_at,
       courier_id, eta_minutes, delivery_sequence, cancel_request, cancel_requested_by,
       cancel_requested_at, cancel_request_attempts, cancel_retry_at, cancel_note, cancel_reason,
       cancellation_fee_minor, refund_minor, version, created_at, updated_at
FROM orders
WHERE id = @id
FOR UPDATE;

-- name: GetOrderByClientKey :one
SELECT id, customer_id, restaurant_id, zone_id, quote_id, client_order_key, status, items,
       subtotal_minor, delivery_fee_minor, surge_bps, total_minor,
       pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, confirm_deadline, ready_at,
       courier_id, eta_minutes, delivery_sequence, cancel_request, cancel_requested_by,
       cancel_requested_at, cancel_request_attempts, cancel_retry_at, cancel_note, cancel_reason,
       cancellation_fee_minor, refund_minor, version, created_at, updated_at
FROM orders
WHERE customer_id = @customer_id AND client_order_key = @client_order_key;

-- name: CountActiveOrders :one
SELECT count(*) FROM orders
WHERE customer_id = @customer_id AND status NOT IN ('delivered', 'cancelled');

-- name: ListOrders :many
SELECT id, customer_id, restaurant_id, zone_id, quote_id, client_order_key, status, items,
       subtotal_minor, delivery_fee_minor, surge_bps, total_minor,
       pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, confirm_deadline, ready_at,
       courier_id, eta_minutes, delivery_sequence, cancel_request, cancel_requested_by,
       cancel_requested_at, cancel_request_attempts, cancel_retry_at, cancel_note, cancel_reason,
       cancellation_fee_minor, refund_minor, version, created_at, updated_at
FROM orders
WHERE (sqlc.narg(status)::text IS NULL OR status = sqlc.narg(status)::text)
ORDER BY created_at DESC, id
LIMIT 100;

-- name: ListOrdersForCustomer :many
SELECT id, customer_id, restaurant_id, zone_id, quote_id, client_order_key, status, items,
       subtotal_minor, delivery_fee_minor, surge_bps, total_minor,
       pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, confirm_deadline, ready_at,
       courier_id, eta_minutes, delivery_sequence, cancel_request, cancel_requested_by,
       cancel_requested_at, cancel_request_attempts, cancel_retry_at, cancel_note, cancel_reason,
       cancellation_fee_minor, refund_minor, version, created_at, updated_at
FROM orders
WHERE customer_id = @customer_id
  AND (sqlc.narg(status)::text IS NULL OR status = sqlc.narg(status)::text)
ORDER BY created_at DESC, id
LIMIT 100;

-- name: ListOrdersForRestaurant :many
SELECT id, customer_id, restaurant_id, zone_id, quote_id, client_order_key, status, items,
       subtotal_minor, delivery_fee_minor, surge_bps, total_minor,
       pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, confirm_deadline, ready_at,
       courier_id, eta_minutes, delivery_sequence, cancel_request, cancel_requested_by,
       cancel_requested_at, cancel_request_attempts, cancel_retry_at, cancel_note, cancel_reason,
       cancellation_fee_minor, refund_minor, version, created_at, updated_at
FROM orders
WHERE restaurant_id = @restaurant_id
  AND (sqlc.narg(status)::text IS NULL OR status = sqlc.narg(status)::text)
ORDER BY created_at DESC, id
LIMIT 100;

-- name: UpdateOrder :execrows
UPDATE orders
SET status = @status,
    ready_at = sqlc.narg(ready_at),
    courier_id = sqlc.narg(courier_id),
    eta_minutes = sqlc.narg(eta_minutes),
    delivery_sequence = @delivery_sequence,
    cancel_request = @cancel_request,
    cancel_requested_by = sqlc.narg(cancel_requested_by),
    cancel_requested_at = sqlc.narg(cancel_requested_at),
    cancel_request_attempts = @cancel_request_attempts,
    cancel_retry_at = sqlc.narg(cancel_retry_at),
    cancel_note = sqlc.narg(cancel_note),
    cancel_reason = sqlc.narg(cancel_reason),
    cancellation_fee_minor = @cancellation_fee_minor,
    refund_minor = @refund_minor,
    version = version + 1,
    updated_at = @updated_at
WHERE id = @id AND version = @expected_version AND status = @expected_status;

-- name: InsertOrderHistory :exec
INSERT INTO order_status_history (order_id, version, status, at, cause)
VALUES (@order_id, @version, @status, @at, @cause);

-- name: ListOrderHistory :many
SELECT order_id, version, status, at, cause
FROM order_status_history
WHERE order_id = @order_id
ORDER BY version;

-- name: ListExpiredPlacedOrders :many
SELECT id FROM orders
WHERE status = 'placed' AND confirm_deadline <= @now
ORDER BY confirm_deadline, id
LIMIT @batch_size::integer
FOR UPDATE SKIP LOCKED;

-- name: ListDueCancelRetries :many
SELECT id FROM orders
WHERE cancel_request = 'pending'
  AND status NOT IN ('delivered', 'cancelled')
  AND cancel_retry_at <= @now::timestamptz
ORDER BY cancel_retry_at, id
LIMIT @batch_size::integer
FOR UPDATE SKIP LOCKED;
