CREATE TABLE settlement_batches (
    id            uuid PRIMARY KEY,
    business_date date        NOT NULL,
    currency      text        NOT NULL,
    status        text        NOT NULL,
    cutoff_at     timestamptz NOT NULL,
    created_at    timestamptz NOT NULL,
    completed_at  timestamptz,
    CONSTRAINT settlement_batches_date_currency_key UNIQUE (business_date, currency),
    CONSTRAINT settlement_batches_status_check CHECK (status IN ('processing', 'completed')),
    CONSTRAINT settlement_batches_completed_check CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE settlement_items (
    batch_id            uuid        NOT NULL REFERENCES settlement_batches (id),
    merchant_account_id uuid        NOT NULL REFERENCES accounts (id),
    outcome             text        NOT NULL,
    amount_minor        bigint      NOT NULL,
    entry_id            uuid REFERENCES journal_entries (id),
    expectation_id      uuid REFERENCES bank_expectations (id),
    created_at          timestamptz NOT NULL,
    CONSTRAINT settlement_items_pkey PRIMARY KEY (batch_id, merchant_account_id),
    CONSTRAINT settlement_items_outcome_check CHECK (outcome IN (
        'paid', 'skipped_zero', 'skipped_below_minimum', 'skipped_frozen', 'skipped_disabled'
    )),
    CONSTRAINT settlement_items_amount_check CHECK (amount_minor >= 0),
    CONSTRAINT settlement_items_paid_check CHECK (
        (outcome = 'paid') = (entry_id IS NOT NULL AND expectation_id IS NOT NULL)
    )
);
