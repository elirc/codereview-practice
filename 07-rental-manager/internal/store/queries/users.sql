-- name: CreateUser :one
INSERT INTO users (email, password_hash, name, role)
VALUES ($1, $2, $3, $4)
RETURNING id, email, password_hash, name, role, active, created_at;

-- name: GetUser :one
SELECT id, email, password_hash, name, role, active, created_at
FROM users
WHERE id = $1;

-- name: GetUserByEmail :one
SELECT id, email, password_hash, name, role, active, created_at
FROM users
WHERE email = $1;

-- name: ListUsers :many
SELECT id, email, password_hash, name, role, active, created_at
FROM users
ORDER BY email;

-- name: UpdateUser :one
UPDATE users
SET name = $2, role = $3, active = $4
WHERE id = $1
RETURNING id, email, password_hash, name, role, active, created_at;

-- name: UpdateUserPassword :exec
UPDATE users
SET password_hash = $2
WHERE id = $1;
