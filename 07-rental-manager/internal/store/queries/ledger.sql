-- name: InsertLedgerEntry :one
INSERT INTO ledger_entries (
    lease_id, entry_date, kind, amount_cents, period, reverses_entry_id, idempotency_key, memo, created_by
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9
)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id, lease_id, entry_date, kind, amount_cents, period, reverses_entry_id,
    idempotency_key, memo, created_by, created_at;

-- name: GetLedgerEntry :one
SELECT id, lease_id, entry_date, kind, amount_cents, period, reverses_entry_id,
    idempotency_key, memo, created_by, created_at
FROM ledger_entries
WHERE id = $1;

-- name: GetLedgerEntryByKey :one
SELECT id, lease_id, entry_date, kind, amount_cents, period, reverses_entry_id,
    idempotency_key, memo, created_by, created_at
FROM ledger_entries
WHERE idempotency_key = $1;

-- name: GetReversalOf :one
SELECT id, lease_id, entry_date, kind, amount_cents, period, reverses_entry_id,
    idempotency_key, memo, created_by, created_at
FROM ledger_entries
WHERE reverses_entry_id = @entry_id::bigint;

-- name: ListLeaseEntries :many
SELECT id, lease_id, entry_date, kind, amount_cents, period, reverses_entry_id,
    idempotency_key, memo, created_by, created_at
FROM ledger_entries
WHERE lease_id = $1
ORDER BY entry_date, id;

-- name: ListLeaseKeys :many
SELECT idempotency_key AS key
FROM ledger_entries
WHERE lease_id = $1;

-- name: ListEntriesThrough :many
SELECT id, lease_id, entry_date, kind, amount_cents, period, reverses_entry_id,
    idempotency_key, memo, created_by, created_at
FROM ledger_entries
WHERE entry_date <= @as_of::date
ORDER BY lease_id, entry_date, id;

-- name: LeaseBalance :one
SELECT COALESCE(SUM(amount_cents), 0)::bigint AS balance
FROM ledger_entries
WHERE lease_id = @lease_id AND entry_date <= @as_of::date;

-- name: ListLeaseBalances :many
SELECT lease_id, COALESCE(SUM(amount_cents), 0)::bigint AS balance
FROM ledger_entries
WHERE entry_date <= @as_of::date
GROUP BY lease_id;

-- name: ListStatementEntries :many
SELECT s.id, s.entry_date, s.kind, s.amount_cents, s.period, s.reverses_entry_id, s.memo,
    s.created_at, r.id AS reversed_by_id, s.running_balance
FROM (
    SELECT e.id, e.entry_date, e.kind, e.amount_cents, e.period, e.reverses_entry_id, e.memo,
        e.created_at,
        (SUM(e.amount_cents) OVER (ORDER BY e.entry_date, e.id))::bigint AS running_balance
    FROM ledger_entries e
    WHERE e.lease_id = @lease_id AND e.entry_date <= @to_date::date
) AS s
LEFT JOIN ledger_entries r ON r.reverses_entry_id = s.id
WHERE s.entry_date >= @from_date::date
ORDER BY s.entry_date, s.id;
