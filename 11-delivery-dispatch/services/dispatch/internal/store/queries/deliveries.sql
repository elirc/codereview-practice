-- name: LockOrderKey :exec
SELECT pg_advisory_xact_lock(@lock_key::bigint);

-- name: CancelledOrderExists :one
SELECT EXISTS (SELECT 1 FROM cancelled_orders WHERE order_id = @order_id)::boolean AS found;

-- name: InsertCancelledOrder :exec
INSERT INTO cancelled_orders (order_id, requested_at)
VALUES (@order_id, @requested_at)
ON CONFLICT (order_id) DO NOTHING;

-- name: InsertDelivery :execrows
INSERT INTO deliveries (
    id, zone_id, status, pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, ready_at,
    delivery_fee_minor, surge_bps, next_offer_at, search_deadline, created_at, updated_at
) VALUES (
    @id, @zone_id, 'searching', @pickup_lon, @pickup_lat, @dropoff_lon, @dropoff_lat, @ready_at,
    @delivery_fee_minor, @surge_bps, @next_offer_at, @search_deadline, @created_at, @created_at
)
ON CONFLICT (id) DO NOTHING;

-- name: GetDelivery :one
SELECT id, zone_id, status, pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, ready_at,
       delivery_fee_minor, surge_bps, courier_id, offers_made, next_offer_at, search_deadline,
       reserve_deadline, eta_minutes, courier_was_assigned, compensation_minor,
       courier_payout_minor, picked_up_at, delivered_at, version, created_at, updated_at
FROM deliveries
WHERE id = @id;

-- name: GetDeliveryForUpdate :one
SELECT id, zone_id, status, pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, ready_at,
       delivery_fee_minor, surge_bps, courier_id, offers_made, next_offer_at, search_deadline,
       reserve_deadline, eta_minutes, courier_was_assigned, compensation_minor,
       courier_payout_minor, picked_up_at, delivered_at, version, created_at, updated_at
FROM deliveries
WHERE id = @id
FOR UPDATE;

-- name: GetDeliveryForUpdateSkipLocked :one
SELECT id, zone_id, status, pickup_lon, pickup_lat, dropoff_lon, dropoff_lat, ready_at,
       delivery_fee_minor, surge_bps, courier_id, offers_made, next_offer_at, search_deadline,
       reserve_deadline, eta_minutes, courier_was_assigned, compensation_minor,
       courier_payout_minor, picked_up_at, delivered_at, version, created_at, updated_at
FROM deliveries
WHERE id = @id
FOR UPDATE SKIP LOCKED;

-- name: UpdateDelivery :exec
UPDATE deliveries
SET status = @status,
    courier_id = sqlc.narg(courier_id),
    offers_made = @offers_made,
    next_offer_at = @next_offer_at,
    reserve_deadline = sqlc.narg(reserve_deadline),
    eta_minutes = sqlc.narg(eta_minutes),
    courier_was_assigned = @courier_was_assigned,
    compensation_minor = @compensation_minor,
    courier_payout_minor = sqlc.narg(courier_payout_minor),
    picked_up_at = sqlc.narg(picked_up_at),
    delivered_at = sqlc.narg(delivered_at),
    version = @version,
    updated_at = @updated_at
WHERE id = @id;

-- name: ListDueDeliveries :many
SELECT id FROM deliveries
WHERE status = 'searching' AND (next_offer_at <= @now OR search_deadline <= @now)
ORDER BY next_offer_at, id
LIMIT @batch_size::integer;

-- name: ListExpiredReservations :many
SELECT id FROM deliveries
WHERE status = 'reserving' AND reserve_deadline <= @now::timestamptz
ORDER BY reserve_deadline, id
LIMIT @batch_size::integer;

-- name: ListSurgeZones :many
SELECT zone_id FROM deliveries WHERE status IN ('searching', 'offered')
UNION
SELECT zone_id FROM courier_view WHERE zone_id IS NOT NULL
UNION
SELECT zone_id FROM zone_surge
ORDER BY zone_id;

-- name: CountZoneDemand :one
SELECT count(*) FROM deliveries
WHERE zone_id = @zone_id AND status IN ('searching', 'offered');

-- name: EnsureZoneSurge :exec
INSERT INTO zone_surge (zone_id, multiplier_bps, version, computed_at)
VALUES (@zone_id, 10000, 0, @computed_at)
ON CONFLICT (zone_id) DO NOTHING;

-- name: GetZoneSurge :one
SELECT zone_id, multiplier_bps, version, computed_at
FROM zone_surge
WHERE zone_id = @zone_id;

-- name: GetZoneSurgeForUpdate :one
SELECT zone_id, multiplier_bps, version, computed_at
FROM zone_surge
WHERE zone_id = @zone_id
FOR UPDATE;

-- name: UpdateZoneSurge :exec
UPDATE zone_surge
SET multiplier_bps = @multiplier_bps,
    version = @version,
    computed_at = @computed_at
WHERE zone_id = @zone_id;
