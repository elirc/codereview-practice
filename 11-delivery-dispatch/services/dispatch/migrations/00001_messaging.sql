-- +goose Up
CREATE TABLE outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE,
    subject text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    published_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    last_error text
);

CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX outbox_published_at_idx ON outbox (published_at) WHERE published_at IS NOT NULL;

CREATE TABLE inbox (
    consumer text NOT NULL,
    event_id uuid NOT NULL,
    processed_at timestamptz NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

CREATE INDEX inbox_processed_at_idx ON inbox (processed_at);

CREATE TABLE dead_letters (
    id uuid PRIMARY KEY,
    consumer text NOT NULL,
    event_id uuid,
    subject text NOT NULL,
    payload bytea NOT NULL,
    error text NOT NULL,
    delivery_count integer NOT NULL,
    created_at timestamptz NOT NULL,
    replayed_at timestamptz
);

CREATE INDEX dead_letters_created_at_idx ON dead_letters (created_at DESC);

-- +goose Down
DROP TABLE dead_letters;
DROP TABLE inbox;
DROP TABLE outbox;
