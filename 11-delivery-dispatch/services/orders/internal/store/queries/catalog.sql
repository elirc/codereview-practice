-- name: ListActiveRestaurants :many
SELECT id, name, zone_id, lon, lat, prep_minutes, active, created_at
FROM restaurants
WHERE active
ORDER BY name, id;

-- name: GetRestaurant :one
SELECT id, name, zone_id, lon, lat, prep_minutes, active, created_at
FROM restaurants
WHERE id = @id;

-- name: UpsertRestaurant :exec
INSERT INTO restaurants (id, name, zone_id, lon, lat, prep_minutes, active, created_at)
VALUES (@id, @name, @zone_id, @lon, @lat, @prep_minutes, @active, @created_at)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    zone_id = EXCLUDED.zone_id,
    lon = EXCLUDED.lon,
    lat = EXCLUDED.lat,
    prep_minutes = EXCLUDED.prep_minutes,
    active = EXCLUDED.active;

-- name: GetZoneSurge :one
SELECT zone_id, multiplier_bps, version, updated_at
FROM zone_surge
WHERE zone_id = @zone_id;

-- name: ApplyZoneSurge :execrows
INSERT INTO zone_surge (zone_id, multiplier_bps, version, updated_at)
VALUES (@zone_id, @multiplier_bps, @version, @updated_at)
ON CONFLICT (zone_id) DO UPDATE
SET multiplier_bps = EXCLUDED.multiplier_bps,
    version = EXCLUDED.version,
    updated_at = EXCLUDED.updated_at
WHERE zone_surge.version < EXCLUDED.version;

-- name: InsertQuote :one
INSERT INTO quotes (
    id, customer_id, restaurant_id, items, subtotal_minor, distance_m, delivery_fee_minor,
    surge_bps, total_minor, eta_minutes, dropoff_lon, dropoff_lat, created_at, expires_at
) VALUES (
    @id, @customer_id, @restaurant_id, @items, @subtotal_minor, @distance_m, @delivery_fee_minor,
    @surge_bps, @total_minor, @eta_minutes, @dropoff_lon, @dropoff_lat, @created_at, @expires_at
)
RETURNING id, customer_id, restaurant_id, items, subtotal_minor, distance_m, delivery_fee_minor,
       surge_bps, total_minor, eta_minutes, dropoff_lon, dropoff_lat, created_at, expires_at,
       used_order_id;

-- name: GetQuoteForUpdate :one
SELECT id, customer_id, restaurant_id, items, subtotal_minor, distance_m, delivery_fee_minor,
       surge_bps, total_minor, eta_minutes, dropoff_lon, dropoff_lat, created_at, expires_at,
       used_order_id
FROM quotes
WHERE id = @id
FOR UPDATE;

-- name: MarkQuoteUsed :execrows
UPDATE quotes
SET used_order_id = @order_id::uuid
WHERE id = @id AND used_order_id IS NULL;
