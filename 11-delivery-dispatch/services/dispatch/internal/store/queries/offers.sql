-- name: InsertOffer :exec
INSERT INTO offers (id, delivery_id, courier_id, status, distance_m, expires_at, created_at)
VALUES (@id, @delivery_id, @courier_id, 'pending', @distance_m, @expires_at, @created_at);

-- name: GetOffer :one
SELECT id, delivery_id, courier_id, status, distance_m, expires_at, created_at, closed_at
FROM offers
WHERE id = @id;

-- name: GetOfferForUpdate :one
SELECT id, delivery_id, courier_id, status, distance_m, expires_at, created_at, closed_at
FROM offers
WHERE id = @id
FOR UPDATE;

-- name: GetPendingOfferForCourier :one
SELECT id, delivery_id, courier_id, status, distance_m, expires_at, created_at, closed_at
FROM offers
WHERE courier_id = @courier_id AND status = 'pending';

-- name: GetPendingOfferForDelivery :one
SELECT id, delivery_id, courier_id, status, distance_m, expires_at, created_at, closed_at
FROM offers
WHERE delivery_id = @delivery_id AND status = 'pending';

-- name: CloseOffer :exec
UPDATE offers
SET status = @status,
    closed_at = @closed_at::timestamptz
WHERE id = @id;

-- name: ListExpiredOffers :many
SELECT id, delivery_id FROM offers
WHERE status = 'pending' AND expires_at <= @now
ORDER BY expires_at, id
LIMIT @batch_size::integer;

-- name: FindCandidate :one
SELECT courier_view.courier_id,
       courier_view.vehicle,
       ST_Distance(
           ST_SetSRID(ST_MakePoint(courier_view.lon, courier_view.lat), 4326)::geography,
           ST_SetSRID(ST_MakePoint(@pickup_lon::float8, @pickup_lat::float8), 4326)::geography
       )::float8 AS distance_m
FROM courier_view
WHERE courier_view.status = 'available'
  AND courier_view.position_at > @fresh_after::timestamptz
  AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(courier_view.lon, courier_view.lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(@pickup_lon::float8, @pickup_lat::float8), 4326)::geography,
          @radius_m::float8
      )
  AND NOT EXISTS (
          SELECT 1 FROM offers p
          WHERE p.courier_id = courier_view.courier_id AND p.status = 'pending'
      )
  AND NOT EXISTS (
          SELECT 1 FROM deliveries d
          WHERE d.courier_id = courier_view.courier_id AND d.status IN ('reserving', 'assigned', 'picked_up')
      )
  AND NOT EXISTS (
          SELECT 1 FROM offers e
          WHERE e.delivery_id = @delivery_id AND e.courier_id = courier_view.courier_id
      )
ORDER BY 3, courier_view.courier_id
LIMIT 1
FOR UPDATE OF courier_view SKIP LOCKED;
