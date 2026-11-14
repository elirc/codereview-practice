-- +goose Up
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE leases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id uuid NOT NULL REFERENCES units (id),
    status text NOT NULL DEFAULT 'draft',
    start_date date NOT NULL,
    end_date date,
    rent_cents bigint NOT NULL,
    due_day integer NOT NULL,
    grace_days integer NOT NULL,
    late_fee_kind text NOT NULL DEFAULT 'none',
    late_fee_flat_cents bigint NOT NULL DEFAULT 0,
    late_fee_bps integer NOT NULL DEFAULT 0,
    late_fee_cap_cents bigint,
    deposit_cents bigint NOT NULL DEFAULT 0,
    activated_at timestamptz,
    ended_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT leases_status_check CHECK (status IN ('draft', 'active', 'ended')),
    CONSTRAINT leases_dates_check CHECK (end_date IS NULL OR end_date >= start_date),
    CONSTRAINT leases_rent_cents_check CHECK (rent_cents > 0),
    CONSTRAINT leases_due_day_check CHECK (due_day BETWEEN 1 AND 31),
    CONSTRAINT leases_grace_days_check CHECK (grace_days BETWEEN 0 AND 15),
    CONSTRAINT leases_late_fee_kind_check CHECK (late_fee_kind IN ('none', 'flat', 'percent')),
    CONSTRAINT leases_late_fee_flat_cents_check CHECK (
        late_fee_flat_cents >= 0 AND (late_fee_kind <> 'flat' OR late_fee_flat_cents > 0)
    ),
    CONSTRAINT leases_late_fee_bps_check CHECK (
        late_fee_bps BETWEEN 0 AND 2500 AND (late_fee_kind <> 'percent' OR late_fee_bps >= 1)
    ),
    CONSTRAINT leases_late_fee_cap_cents_check CHECK (late_fee_cap_cents IS NULL OR late_fee_cap_cents > 0),
    CONSTRAINT leases_deposit_cents_check CHECK (deposit_cents >= 0),
    CONSTRAINT leases_activated_at_check CHECK (status = 'draft' OR activated_at IS NOT NULL),
    CONSTRAINT leases_ended_check CHECK (status <> 'ended' OR (ended_at IS NOT NULL AND end_date IS NOT NULL)),
    CONSTRAINT leases_unit_no_overlap EXCLUDE USING gist (
        unit_id WITH =,
        daterange(start_date, COALESCE(end_date + 1, 'infinity'::date), '[)') WITH &&
    ) WHERE (status = 'active')
);

CREATE INDEX leases_unit_id_idx ON leases (unit_id);
CREATE INDEX leases_status_idx ON leases (status);

CREATE TABLE lease_tenants (
    lease_id uuid NOT NULL REFERENCES leases (id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    is_primary boolean NOT NULL DEFAULT false,
    PRIMARY KEY (lease_id, tenant_id)
);

CREATE UNIQUE INDEX lease_tenants_one_primary_idx ON lease_tenants (lease_id) WHERE is_primary;
CREATE INDEX lease_tenants_tenant_id_idx ON lease_tenants (tenant_id);

-- +goose Down
DROP TABLE lease_tenants;
DROP TABLE leases;
