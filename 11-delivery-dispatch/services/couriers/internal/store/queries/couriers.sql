-- name: InsertCourier :one
INSERT INTO couriers (id, name, vehicle, status_version, created_at, updated_at)
VALUES (@id, @name, @vehicle, 1, @created_at, @created_at)
RETURNING id, name, vehicle, suspended, shift_zone_id, active_delivery_id, status_version,
       lon, lat, position_at, published_lon, published_lat, published_at, position_seq,
       created_at, updated_at;

-- name: UpsertCourier :exec
INSERT INTO couriers (id, name, vehicle, status_version, created_at, updated_at)
VALUES (@id, @name, @vehicle, 1, @created_at, @created_at)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    vehicle = EXCLUDED.vehicle;

-- name: GetCourier :one
SELECT id, name, vehicle, suspended, shift_zone_id, active_delivery_id, status_version,
       lon, lat, position_at, published_lon, published_lat, published_at, position_seq,
       created_at, updated_at
FROM couriers
WHERE id = @id;

-- name: GetCourierForUpdate :one
SELECT id, name, vehicle, suspended, shift_zone_id, active_delivery_id, status_version,
       lon, lat, position_at, published_lon, published_lat, published_at, position_seq,
       created_at, updated_at
FROM couriers
WHERE id = @id
FOR UPDATE;

-- name: UpdateCourierStatus :exec
UPDATE couriers
SET suspended = @suspended,
    shift_zone_id = sqlc.narg(shift_zone_id),
    active_delivery_id = sqlc.narg(active_delivery_id),
    status_version = @status_version,
    updated_at = @updated_at
WHERE id = @id;

-- name: UpdateCourierPosition :exec
UPDATE couriers
SET lon = @lon::float8,
    lat = @lat::float8,
    position_at = @position_at::timestamptz,
    updated_at = @updated_at
WHERE id = @id;

-- name: MarkPositionPublished :exec
UPDATE couriers
SET published_lon = @lon::float8,
    published_lat = @lat::float8,
    published_at = @published_at::timestamptz,
    position_seq = @position_seq
WHERE id = @id;

-- name: DistanceFromPublished :one
SELECT COALESCE(
           ST_Distance(
               ST_SetSRID(ST_MakePoint(published_lon, published_lat), 4326)::geography,
               ST_SetSRID(ST_MakePoint(@lon::float8, @lat::float8), 4326)::geography
           ),
           0
       )::float8 AS distance_m
FROM couriers
WHERE id = @id;

-- name: InsertEarning :execrows
INSERT INTO courier_earnings (id, courier_id, delivery_id, kind, amount_minor, created_at)
VALUES (@id, @courier_id, @delivery_id, @kind, @amount_minor, @created_at)
ON CONFLICT (courier_id, delivery_id, kind) DO NOTHING;

-- name: ListDeliveryEarnings :many
SELECT id, courier_id, delivery_id, kind, amount_minor, created_at
FROM courier_earnings
WHERE delivery_id = @delivery_id
ORDER BY created_at, id;

-- name: ListEarnings :many
SELECT id, courier_id, delivery_id, kind, amount_minor, created_at
FROM courier_earnings
WHERE courier_id = @courier_id
ORDER BY created_at DESC, id
LIMIT 200;

-- name: SumEarnings :one
SELECT COALESCE(sum(amount_minor), 0)::bigint AS total_minor
FROM courier_earnings
WHERE courier_id = @courier_id;

-- name: SumEarningsByKind :many
SELECT kind, sum(amount_minor)::bigint AS total_minor
FROM courier_earnings
WHERE courier_id = @courier_id
GROUP BY kind
ORDER BY kind;
