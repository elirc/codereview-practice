CREATE TABLE statements (
    id                uuid PRIMARY KEY,
    bank_account_code text        NOT NULL,
    currency          text        NOT NULL,
    statement_date    date        NOT NULL,
    opening_minor     bigint      NOT NULL,
    closing_minor     bigint      NOT NULL,
    file_sha256       text        NOT NULL,
    line_count        integer     NOT NULL,
    imported_by       uuid        NOT NULL REFERENCES api_keys (id),
    imported_at       timestamptz NOT NULL,
    CONSTRAINT statements_file_sha256_key UNIQUE (file_sha256),
    CONSTRAINT statements_code_date_key UNIQUE (bank_account_code, statement_date),
    CONSTRAINT statements_currency_check CHECK (currency IN ('USD', 'EUR', 'GBP', 'JPY', 'KWD')),
    CONSTRAINT statements_line_count_check CHECK (line_count BETWEEN 0 AND 50000)
);

CREATE TABLE statement_lines (
    id                     uuid PRIMARY KEY,
    statement_id           uuid        NOT NULL REFERENCES statements (id),
    line_no                integer     NOT NULL,
    bank_account_code      text        NOT NULL,
    bank_line_id           text        NOT NULL,
    booking_date           date        NOT NULL,
    amount_minor           bigint      NOT NULL,
    reference              text        NOT NULL,
    description            text        NOT NULL,
    status                 text        NOT NULL,
    matched_expectation_id uuid REFERENCES bank_expectations (id),
    entry_id               uuid REFERENCES journal_entries (id),
    resolution_entry_id    uuid REFERENCES journal_entries (id),
    note                   text,
    attempts               integer     NOT NULL DEFAULT 0,
    created_at             timestamptz NOT NULL,
    updated_at             timestamptz NOT NULL,
    CONSTRAINT statement_lines_statement_line_key UNIQUE (statement_id, line_no),
    CONSTRAINT statement_lines_amount_check CHECK (amount_minor <> 0),
    CONSTRAINT statement_lines_status_check CHECK (status IN (
        'pending', 'matched', 'unmatched', 'amount_mismatch', 'duplicate', 'resolved'
    ))
);

CREATE UNIQUE INDEX statement_lines_bank_line_key
    ON statement_lines (bank_account_code, bank_line_id)
    WHERE status <> 'duplicate';

CREATE INDEX statement_lines_pending_idx ON statement_lines (statement_id, line_no) WHERE status = 'pending';
CREATE INDEX statement_lines_open_status_idx ON statement_lines (status) WHERE status IN ('unmatched', 'amount_mismatch');

ALTER TABLE bank_expectations
    ADD CONSTRAINT bank_expectations_matched_line_id_fkey FOREIGN KEY (matched_line_id) REFERENCES statement_lines (id);
