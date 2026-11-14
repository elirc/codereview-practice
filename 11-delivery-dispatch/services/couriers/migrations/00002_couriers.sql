-- +goose Up
CREATE TABLE couriers (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    vehicle text NOT NULL CHECK (vehicle IN ('bike', 'scooter', 'car')),
    suspended boolean NOT NULL DEFAULT false,
    shift_zone_id text,
    active_delivery_id uuid,
    status_version bigint NOT NULL DEFAULT 0 CHECK (status_version >= 0),
    lon double precision,
    lat double precision,
    position_at timestamptz,
    published_lon double precision,
    published_lat double precision,
    published_at timestamptz,
    position_seq bigint NOT NULL DEFAULT 0 CHECK (position_seq >= 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT couriers_position_check CHECK ((lon IS NULL) = (lat IS NULL) AND (lon IS NULL) = (position_at IS NULL)),
    CONSTRAINT couriers_published_check CHECK ((published_lon IS NULL) = (published_at IS NULL) AND (published_lat IS NULL) = (published_at IS NULL)),
    CONSTRAINT couriers_lon_check CHECK (lon BETWEEN -180 AND 180),
    CONSTRAINT couriers_lat_check CHECK (lat BETWEEN -90 AND 90)
);

CREATE UNIQUE INDEX couriers_active_delivery_idx ON couriers (active_delivery_id) WHERE active_delivery_id IS NOT NULL;

CREATE TABLE courier_earnings (
    id uuid PRIMARY KEY,
    courier_id uuid NOT NULL REFERENCES couriers (id),
    delivery_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('delivery', 'cancellation_compensation')),
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    created_at timestamptz NOT NULL,
    CONSTRAINT courier_earnings_unique UNIQUE (courier_id, delivery_id, kind)
);

CREATE INDEX courier_earnings_courier_idx ON courier_earnings (courier_id, created_at DESC);

-- +goose Down
DROP TABLE courier_earnings;
DROP TABLE couriers;
