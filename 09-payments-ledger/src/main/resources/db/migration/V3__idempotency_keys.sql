CREATE TABLE idempotency_keys (
    api_key_id      uuid        NOT NULL REFERENCES api_keys (id),
    key             text        NOT NULL,
    fingerprint     text        NOT NULL,
    state           text        NOT NULL,
    response_status integer,
    response_body   jsonb,
    created_at      timestamptz NOT NULL,
    CONSTRAINT idempotency_keys_pkey PRIMARY KEY (api_key_id, key),
    CONSTRAINT idempotency_keys_state_check CHECK (state IN ('in_progress', 'completed')),
    CONSTRAINT idempotency_keys_response_check CHECK (
        state = 'in_progress' OR (response_status IS NOT NULL AND response_body IS NOT NULL)
    )
);

CREATE INDEX idempotency_keys_completed_created_idx ON idempotency_keys (created_at) WHERE state = 'completed';
