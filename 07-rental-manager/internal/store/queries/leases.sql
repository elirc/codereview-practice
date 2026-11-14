-- name: CreateLease :one
INSERT INTO leases (
    unit_id, start_date, end_date, rent_cents, due_day, grace_days,
    late_fee_kind, late_fee_flat_cents, late_fee_bps, late_fee_cap_cents, deposit_cents
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
)
RETURNING id, unit_id, status, start_date, end_date, rent_cents, due_day, grace_days,
    late_fee_kind, late_fee_flat_cents, late_fee_bps, late_fee_cap_cents, deposit_cents,
    activated_at, ended_at, created_at;

-- name: GetLease :one
SELECT id, unit_id, status, start_date, end_date, rent_cents, due_day, grace_days,
    late_fee_kind, late_fee_flat_cents, late_fee_bps, late_fee_cap_cents, deposit_cents,
    activated_at, ended_at, created_at
FROM leases
WHERE id = $1;

-- name: GetLeaseForUpdate :one
SELECT id, unit_id, status, start_date, end_date, rent_cents, due_day, grace_days,
    late_fee_kind, late_fee_flat_cents, late_fee_bps, late_fee_cap_cents, deposit_cents,
    activated_at, ended_at, created_at
FROM leases
WHERE id = $1
FOR UPDATE;

-- name: ListLeases :many
SELECT l.id, l.status, l.start_date, l.end_date, l.rent_cents, l.due_day,
    u.label AS unit_label, p.name AS property_name, t.full_name AS primary_tenant_name
FROM leases l
JOIN units u ON u.id = l.unit_id
JOIN properties p ON p.id = u.property_id
LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.is_primary
LEFT JOIN tenants t ON t.id = lt.tenant_id
ORDER BY p.name, u.label, l.start_date DESC;

-- name: ListBillableLeaseIDs :many
SELECT id
FROM leases
WHERE status IN ('active', 'ended')
ORDER BY id;

-- name: UpdateDraftLease :one
UPDATE leases
SET unit_id = $2, start_date = $3, end_date = $4, rent_cents = $5, due_day = $6, grace_days = $7,
    late_fee_kind = $8, late_fee_flat_cents = $9, late_fee_bps = $10, late_fee_cap_cents = $11,
    deposit_cents = $12
WHERE id = $1 AND status = 'draft'
RETURNING id, unit_id, status, start_date, end_date, rent_cents, due_day, grace_days,
    late_fee_kind, late_fee_flat_cents, late_fee_bps, late_fee_cap_cents, deposit_cents,
    activated_at, ended_at, created_at;

-- name: UpdateLeaseFeeTerms :one
UPDATE leases
SET grace_days = $2, late_fee_kind = $3, late_fee_flat_cents = $4, late_fee_bps = $5, late_fee_cap_cents = $6
WHERE id = $1
RETURNING id, unit_id, status, start_date, end_date, rent_cents, due_day, grace_days,
    late_fee_kind, late_fee_flat_cents, late_fee_bps, late_fee_cap_cents, deposit_cents,
    activated_at, ended_at, created_at;

-- name: DeleteDraftLease :execrows
DELETE FROM leases
WHERE id = $1 AND status = 'draft';

-- name: ActivateLease :one
UPDATE leases
SET status = 'active', activated_at = $2
WHERE id = $1 AND status = 'draft'
RETURNING id, unit_id, status, start_date, end_date, rent_cents, due_day, grace_days,
    late_fee_kind, late_fee_flat_cents, late_fee_bps, late_fee_cap_cents, deposit_cents,
    activated_at, ended_at, created_at;

-- name: EndLease :one
UPDATE leases
SET status = 'ended', end_date = $2, ended_at = $3
WHERE id = $1 AND status = 'active'
RETURNING id, unit_id, status, start_date, end_date, rent_cents, due_day, grace_days,
    late_fee_kind, late_fee_flat_cents, late_fee_bps, late_fee_cap_cents, deposit_cents,
    activated_at, ended_at, created_at;

-- name: ListLeaseTenants :many
SELECT lt.tenant_id, lt.is_primary, t.full_name
FROM lease_tenants lt
JOIN tenants t ON t.id = lt.tenant_id
WHERE lt.lease_id = $1
ORDER BY lt.is_primary DESC, t.full_name;

-- name: DeleteLeaseTenants :exec
DELETE FROM lease_tenants
WHERE lease_id = $1;

-- name: AddLeaseTenant :exec
INSERT INTO lease_tenants (lease_id, tenant_id, is_primary)
VALUES ($1, $2, $3);
