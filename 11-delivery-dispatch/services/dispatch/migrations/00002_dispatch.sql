-- +goose Up
CREATE TABLE deliveries (
    id uuid PRIMARY KEY,
    zone_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('searching', 'offered', 'reserving', 'assigned', 'picked_up', 'delivered', 'cancelled', 'failed')),
    pickup_lon double precision NOT NULL CHECK (pickup_lon BETWEEN -180 AND 180),
    pickup_lat double precision NOT NULL CHECK (pickup_lat BETWEEN -90 AND 90),
    dropoff_lon double precision NOT NULL CHECK (dropoff_lon BETWEEN -180 AND 180),
    dropoff_lat double precision NOT NULL CHECK (dropoff_lat BETWEEN -90 AND 90),
    ready_at timestamptz NOT NULL,
    delivery_fee_minor bigint NOT NULL CHECK (delivery_fee_minor >= 0),
    surge_bps integer NOT NULL CHECK (surge_bps > 0),
    courier_id uuid,
    offers_made integer NOT NULL DEFAULT 0 CHECK (offers_made >= 0),
    next_offer_at timestamptz NOT NULL,
    search_deadline timestamptz NOT NULL,
    reserve_deadline timestamptz,
    eta_minutes integer CHECK (eta_minutes >= 0),
    courier_was_assigned boolean NOT NULL DEFAULT false,
    compensation_minor bigint NOT NULL DEFAULT 0 CHECK (compensation_minor >= 0),
    courier_payout_minor bigint CHECK (courier_payout_minor >= 0),
    picked_up_at timestamptz,
    delivered_at timestamptz,
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT deliveries_courier_check CHECK (status NOT IN ('reserving', 'assigned', 'picked_up', 'delivered') OR courier_id IS NOT NULL),
    CONSTRAINT deliveries_reserve_check CHECK (status <> 'reserving' OR reserve_deadline IS NOT NULL)
);

CREATE UNIQUE INDEX deliveries_active_courier_idx ON deliveries (courier_id)
    WHERE status IN ('reserving', 'assigned', 'picked_up');
CREATE INDEX deliveries_searching_idx ON deliveries (next_offer_at) WHERE status = 'searching';
CREATE INDEX deliveries_reserving_idx ON deliveries (reserve_deadline) WHERE status = 'reserving';
CREATE INDEX deliveries_zone_open_idx ON deliveries (zone_id) WHERE status IN ('searching', 'offered');

CREATE TABLE offers (
    id uuid PRIMARY KEY,
    delivery_id uuid NOT NULL REFERENCES deliveries (id),
    courier_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
    distance_m double precision NOT NULL CHECK (distance_m >= 0),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    closed_at timestamptz,
    CONSTRAINT offers_closed_check CHECK ((status = 'pending') = (closed_at IS NULL))
);

CREATE UNIQUE INDEX offers_pending_delivery_idx ON offers (delivery_id) WHERE status = 'pending';
CREATE UNIQUE INDEX offers_pending_courier_idx ON offers (courier_id) WHERE status = 'pending';
CREATE UNIQUE INDEX offers_delivery_courier_idx ON offers (delivery_id, courier_id);
CREATE INDEX offers_pending_expiry_idx ON offers (expires_at) WHERE status = 'pending';

CREATE TABLE courier_view (
    courier_id uuid PRIMARY KEY,
    zone_id text,
    status text NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'available', 'busy')),
    vehicle text NOT NULL DEFAULT 'bike' CHECK (vehicle IN ('bike', 'scooter', 'car')),
    status_version bigint NOT NULL DEFAULT 0,
    lon double precision,
    lat double precision,
    position_at timestamptz,
    CONSTRAINT courier_view_position_check CHECK ((lon IS NULL) = (lat IS NULL) AND (lon IS NULL) = (position_at IS NULL))
);

CREATE INDEX courier_view_position_gix ON courier_view
    USING gist ((ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography));
CREATE INDEX courier_view_zone_idx ON courier_view (zone_id) WHERE status = 'available';

CREATE TABLE cancelled_orders (
    order_id uuid PRIMARY KEY,
    requested_at timestamptz NOT NULL
);

CREATE TABLE zone_surge (
    zone_id text PRIMARY KEY,
    multiplier_bps integer NOT NULL CHECK (multiplier_bps > 0),
    version bigint NOT NULL CHECK (version >= 0),
    computed_at timestamptz NOT NULL
);

-- +goose Down
DROP TABLE zone_surge;
DROP TABLE cancelled_orders;
DROP TABLE courier_view;
DROP TABLE offers;
DROP TABLE deliveries;
