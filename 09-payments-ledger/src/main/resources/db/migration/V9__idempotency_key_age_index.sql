DROP INDEX idempotency_keys_completed_created_idx;

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
