CREATE TABLE holds (
    id                  uuid PRIMARY KEY,
    account_id          uuid        NOT NULL REFERENCES accounts (id),
    merchant_account_id uuid        NOT NULL REFERENCES accounts (id),
    amount_minor        bigint      NOT NULL,
    captured_minor      bigint      NOT NULL DEFAULT 0,
    currency            text        NOT NULL,
    status              text        NOT NULL,
    expires_at          timestamptz NOT NULL,
    authorized_on       date        NOT NULL,
    capture_entry_id    uuid REFERENCES journal_entries (id),
    version             bigint      NOT NULL,
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT holds_amount_check CHECK (amount_minor > 0),
    CONSTRAINT holds_captured_nonnegative_check CHECK (captured_minor >= 0),
    CONSTRAINT holds_captured_check CHECK (captured_minor <= amount_minor),
    CONSTRAINT holds_status_check CHECK (status IN ('active', 'captured', 'released', 'expired')),
    CONSTRAINT holds_capture_entry_check CHECK ((status = 'captured') = (capture_entry_id IS NOT NULL))
);

CREATE INDEX holds_active_expiry_idx ON holds (expires_at) WHERE status = 'active';
CREATE INDEX holds_active_account_idx ON holds (account_id) WHERE status = 'active';
CREATE INDEX holds_merchant_account_idx ON holds (merchant_account_id);
