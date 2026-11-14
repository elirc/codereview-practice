-- name: CreateTenant :one
INSERT INTO tenants (full_name, email, phone)
VALUES ($1, $2, $3)
RETURNING id, full_name, email, phone, created_at;

-- name: GetTenant :one
SELECT id, full_name, email, phone, created_at
FROM tenants
WHERE id = $1;

-- name: ListTenants :many
SELECT id, full_name, email, phone, created_at
FROM tenants
ORDER BY full_name;

-- name: UpdateTenant :one
UPDATE tenants
SET full_name = $2, email = $3, phone = $4
WHERE id = $1
RETURNING id, full_name, email, phone, created_at;

-- name: ListTenantLeases :many
SELECT l.id, l.status, l.start_date, l.end_date, lt.is_primary, u.label AS unit_label, p.name AS property_name
FROM lease_tenants lt
JOIN leases l ON l.id = lt.lease_id
JOIN units u ON u.id = l.unit_id
JOIN properties p ON p.id = u.property_id
WHERE lt.tenant_id = $1
ORDER BY l.start_date DESC;
