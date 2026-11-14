-- name: GetCourierView :one
SELECT courier_id, zone_id, status, vehicle, status_version, lon, lat, position_at
FROM courier_view
WHERE courier_id = @courier_id;

-- name: ApplyCourierStatus :execrows
INSERT INTO courier_view (courier_id, zone_id, status, vehicle, status_version)
VALUES (@courier_id, sqlc.narg(zone_id), @status, @vehicle, @status_version)
ON CONFLICT (courier_id) DO UPDATE
SET zone_id = EXCLUDED.zone_id,
    status = EXCLUDED.status,
    vehicle = EXCLUDED.vehicle,
    status_version = EXCLUDED.status_version
WHERE courier_view.status_version < EXCLUDED.status_version;

-- name: ApplyCourierPosition :execrows
INSERT INTO courier_view (courier_id, lon, lat, position_at)
VALUES (@courier_id, @lon::float8, @lat::float8, @position_at::timestamptz)
ON CONFLICT (courier_id) DO UPDATE
SET lon = EXCLUDED.lon,
    lat = EXCLUDED.lat,
    position_at = EXCLUDED.position_at
WHERE courier_view.position_at IS NULL OR courier_view.position_at < EXCLUDED.position_at;

-- name: GetAssignmentDistances :one
SELECT vehicle,
       COALESCE(
           ST_Distance(
               ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
               ST_SetSRID(ST_MakePoint(@pickup_lon::float8, @pickup_lat::float8), 4326)::geography
           ),
           0
       )::float8 AS to_pickup_m,
       ST_Distance(
           ST_SetSRID(ST_MakePoint(@pickup_lon::float8, @pickup_lat::float8), 4326)::geography,
           ST_SetSRID(ST_MakePoint(@dropoff_lon::float8, @dropoff_lat::float8), 4326)::geography
       )::float8 AS to_dropoff_m
FROM courier_view
WHERE courier_id = @courier_id;

-- name: CountZoneSupply :one
SELECT count(*) FROM courier_view
WHERE zone_id = @zone_id::text
  AND status = 'available'
  AND position_at > @fresh_after::timestamptz;
