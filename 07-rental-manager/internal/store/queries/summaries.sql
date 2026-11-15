-- name: AddToLeaseSummary :exec
INSERT INTO lease_summaries (lease_id, balance_cents, updated_at)
VALUES (@lease_id, @amount_cents, now())
ON CONFLICT (lease_id) DO UPDATE
SET balance_cents = lease_summaries.balance_cents + EXCLUDED.balance_cents, updated_at = now();

-- name: GetLeaseSummary :one
SELECT lease_id, balance_cents, updated_at
FROM lease_summaries
WHERE lease_id = $1;

-- name: ListLeaseSummaries :many
SELECT lease_id, balance_cents, updated_at
FROM lease_summaries;

-- name: DeleteLeaseSummaries :exec
DELETE FROM lease_summaries;

-- name: RebuildLeaseSummaries :execrows
INSERT INTO lease_summaries (lease_id, balance_cents)
SELECT lease_id, SUM(amount_cents)::bigint
FROM ledger_entries
GROUP BY lease_id;
