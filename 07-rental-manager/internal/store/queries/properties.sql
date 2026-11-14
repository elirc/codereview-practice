-- name: CreateProperty :one
INSERT INTO properties (name, address)
VALUES ($1, $2)
RETURNING id, name, address, created_at;

-- name: GetProperty :one
SELECT id, name, address, created_at
FROM properties
WHERE id = $1;

-- name: ListProperties :many
SELECT p.id, p.name, p.address, COUNT(u.id) AS unit_count
FROM properties p
LEFT JOIN units u ON u.property_id = p.id
GROUP BY p.id
ORDER BY p.name;

-- name: UpdateProperty :one
UPDATE properties
SET name = $2, address = $3
WHERE id = $1
RETURNING id, name, address, created_at;

-- name: CreateUnit :one
INSERT INTO units (property_id, label, bedrooms, market_rent_cents)
VALUES ($1, $2, $3, $4)
RETURNING id, property_id, label, bedrooms, market_rent_cents, created_at;

-- name: GetUnit :one
SELECT id, property_id, label, bedrooms, market_rent_cents, created_at
FROM units
WHERE id = $1;

-- name: ListUnitsByProperty :many
SELECT id, property_id, label, bedrooms, market_rent_cents, created_at
FROM units
WHERE property_id = $1
ORDER BY label;

-- name: UpdateUnit :one
UPDATE units
SET label = $2, bedrooms = $3, market_rent_cents = $4
WHERE id = $1
RETURNING id, property_id, label, bedrooms, market_rent_cents, created_at;

-- name: ListUnitOptions :many
SELECT u.id, u.label, p.name AS property_name
FROM units u
JOIN properties p ON p.id = u.property_id
ORDER BY p.name, u.label;
