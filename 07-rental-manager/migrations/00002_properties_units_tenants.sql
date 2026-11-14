-- +goose Up
CREATE TABLE properties (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    address text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT properties_name_check CHECK (btrim(name) <> '')
);

CREATE TABLE units (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id uuid NOT NULL REFERENCES properties (id),
    label text NOT NULL,
    bedrooms integer NOT NULL,
    market_rent_cents bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT units_property_id_label_key UNIQUE (property_id, label),
    CONSTRAINT units_label_check CHECK (btrim(label) <> ''),
    CONSTRAINT units_bedrooms_check CHECK (bedrooms BETWEEN 0 AND 20),
    CONSTRAINT units_market_rent_cents_check CHECK (market_rent_cents >= 0)
);

CREATE TABLE tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name text NOT NULL,
    email text,
    phone text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenants_full_name_check CHECK (btrim(full_name) <> '')
);

-- +goose Down
DROP TABLE tenants;
DROP TABLE units;
DROP TABLE properties;
