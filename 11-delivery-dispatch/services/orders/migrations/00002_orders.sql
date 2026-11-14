-- +goose Up
CREATE TABLE restaurants (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    zone_id text NOT NULL,
    lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    prep_minutes integer NOT NULL CHECK (prep_minutes BETWEEN 1 AND 120),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL
);

CREATE TABLE zone_surge (
    zone_id text PRIMARY KEY,
    multiplier_bps integer NOT NULL CHECK (multiplier_bps > 0),
    version bigint NOT NULL CHECK (version >= 0),
    updated_at timestamptz NOT NULL
);

CREATE TABLE quotes (
    id uuid PRIMARY KEY,
    customer_id uuid NOT NULL,
    restaurant_id uuid NOT NULL REFERENCES restaurants (id),
    items jsonb NOT NULL,
    subtotal_minor bigint NOT NULL CHECK (subtotal_minor > 0),
    distance_m integer NOT NULL CHECK (distance_m >= 0),
    delivery_fee_minor bigint NOT NULL CHECK (delivery_fee_minor >= 0),
    surge_bps integer NOT NULL CHECK (surge_bps > 0),
    total_minor bigint NOT NULL,
    eta_minutes integer NOT NULL CHECK (eta_minutes > 0),
    dropoff_lon double precision NOT NULL CHECK (dropoff_lon BETWEEN -180 AND 180),
    dropoff_lat double precision NOT NULL CHECK (dropoff_lat BETWEEN -90 AND 90),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    used_order_id uuid,
    CONSTRAINT quotes_total_check CHECK (total_minor = subtotal_minor + delivery_fee_minor),
    CONSTRAINT quotes_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX quotes_customer_idx ON quotes (customer_id, created_at);

CREATE TABLE orders (
    id uuid PRIMARY KEY,
    customer_id uuid NOT NULL,
    restaurant_id uuid NOT NULL REFERENCES restaurants (id),
    zone_id text NOT NULL,
    quote_id uuid NOT NULL REFERENCES quotes (id),
    client_order_key text NOT NULL CHECK (length(client_order_key) BETWEEN 8 AND 64),
    status text NOT NULL CHECK (status IN ('placed', 'confirmed', 'courier_assigned', 'picked_up', 'delivered', 'cancelled')),
    items jsonb NOT NULL,
    subtotal_minor bigint NOT NULL CHECK (subtotal_minor > 0),
    delivery_fee_minor bigint NOT NULL CHECK (delivery_fee_minor >= 0),
    surge_bps integer NOT NULL CHECK (surge_bps > 0),
    total_minor bigint NOT NULL,
    pickup_lon double precision NOT NULL,
    pickup_lat double precision NOT NULL,
    dropoff_lon double precision NOT NULL,
    dropoff_lat double precision NOT NULL,
    confirm_deadline timestamptz NOT NULL,
    ready_at timestamptz,
    courier_id uuid,
    eta_minutes integer CHECK (eta_minutes >= 0),
    delivery_sequence bigint NOT NULL DEFAULT 0 CHECK (delivery_sequence >= 0),
    cancel_request text NOT NULL DEFAULT 'none' CHECK (cancel_request IN ('none', 'pending', 'rejected')),
    cancel_requested_by text CHECK (cancel_requested_by IN ('customer', 'restaurant', 'ops')),
    cancel_requested_at timestamptz,
    cancel_request_attempts integer NOT NULL DEFAULT 0 CHECK (cancel_request_attempts >= 0),
    cancel_retry_at timestamptz,
    cancel_note text CHECK (length(cancel_note) <= 500),
    cancel_reason text CHECK (cancel_reason IN ('customer', 'restaurant', 'ops', 'restaurant_rejected', 'confirm_timeout', 'no_courier')),
    cancellation_fee_minor bigint NOT NULL DEFAULT 0 CHECK (cancellation_fee_minor >= 0),
    refund_minor bigint NOT NULL DEFAULT 0 CHECK (refund_minor >= 0),
    version bigint NOT NULL CHECK (version >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT orders_quote_unique UNIQUE (quote_id),
    CONSTRAINT orders_customer_key_unique UNIQUE (customer_id, client_order_key),
    CONSTRAINT orders_total_check CHECK (total_minor = subtotal_minor + delivery_fee_minor),
    CONSTRAINT orders_refund_check CHECK (cancellation_fee_minor + refund_minor <= total_minor),
    CONSTRAINT orders_cancel_reason_check CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
    CONSTRAINT orders_pending_request_check CHECK (cancel_request = 'none' OR cancel_requested_by IS NOT NULL)
);

CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_restaurant_idx ON orders (restaurant_id, created_at DESC);
CREATE INDEX orders_created_idx ON orders (created_at DESC);
CREATE INDEX orders_confirm_deadline_idx ON orders (confirm_deadline) WHERE status = 'placed';
CREATE INDEX orders_cancel_retry_idx ON orders (cancel_retry_at) WHERE cancel_request = 'pending';

CREATE TABLE order_status_history (
    order_id uuid NOT NULL REFERENCES orders (id),
    version bigint NOT NULL,
    status text NOT NULL,
    at timestamptz NOT NULL,
    cause text NOT NULL,
    PRIMARY KEY (order_id, version)
);

-- +goose Down
DROP TABLE order_status_history;
DROP TABLE orders;
DROP TABLE quotes;
DROP TABLE zone_surge;
DROP TABLE restaurants;
