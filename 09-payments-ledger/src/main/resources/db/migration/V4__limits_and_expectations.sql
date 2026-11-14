CREATE TABLE owner_limits (
    owner_id        uuid        NOT NULL,
    currency        text        NOT NULL,
    daily_out_minor bigint      NOT NULL,
    updated_at      timestamptz NOT NULL,
    updated_by      uuid REFERENCES api_keys (id),
    CONSTRAINT owner_limits_pkey PRIMARY KEY (owner_id, currency),
    CONSTRAINT owner_limits_currency_check CHECK (currency IN ('USD', 'EUR', 'GBP', 'JPY', 'KWD')),
    CONSTRAINT owner_limits_amount_check CHECK (daily_out_minor >= 0)
);

CREATE TABLE owner_daily_usage (
    owner_id   uuid   NOT NULL,
    currency   text   NOT NULL,
    day        date   NOT NULL,
    used_minor bigint NOT NULL DEFAULT 0,
    CONSTRAINT owner_daily_usage_pkey PRIMARY KEY (owner_id, currency, day),
    CONSTRAINT owner_daily_usage_used_check CHECK (used_minor >= 0)
);

CREATE TABLE bank_expectations (
    id              uuid PRIMARY KEY,
    kind            text        NOT NULL,
    reference       text        NOT NULL,
    account_id      uuid        NOT NULL REFERENCES accounts (id),
    amount_minor    bigint      NOT NULL,
    currency        text        NOT NULL,
    source_entry_id uuid        NOT NULL REFERENCES journal_entries (id),
    status          text        NOT NULL DEFAULT 'open',
    matched_line_id uuid,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    CONSTRAINT bank_expectations_reference_key UNIQUE (reference),
    CONSTRAINT bank_expectations_source_entry_key UNIQUE (source_entry_id),
    CONSTRAINT bank_expectations_kind_check CHECK (kind IN ('withdrawal', 'payout')),
    CONSTRAINT bank_expectations_status_check CHECK (status IN ('open', 'matched', 'returned', 'cancelled')),
    CONSTRAINT bank_expectations_amount_check CHECK (amount_minor > 0)
);

CREATE INDEX bank_expectations_open_account_idx ON bank_expectations (account_id) WHERE status = 'open';
CREATE INDEX bank_expectations_open_created_idx ON bank_expectations (created_at) WHERE status = 'open';
