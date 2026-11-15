-- +goose Up
CREATE TABLE lease_summaries (
    lease_id uuid PRIMARY KEY REFERENCES leases (id) ON DELETE CASCADE,
    balance_cents bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO lease_summaries (lease_id, balance_cents)
SELECT lease_id, SUM(amount_cents)::bigint
FROM ledger_entries
GROUP BY lease_id;

-- +goose Down
DROP TABLE lease_summaries;
