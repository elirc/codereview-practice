-- +goose Up
CREATE TABLE ledger_entries (
    id bigserial PRIMARY KEY,
    lease_id uuid NOT NULL REFERENCES leases (id),
    entry_date date NOT NULL,
    kind text NOT NULL,
    amount_cents bigint NOT NULL,
    period text,
    reverses_entry_id bigint REFERENCES ledger_entries (id),
    idempotency_key text NOT NULL,
    memo text NOT NULL DEFAULT '',
    created_by uuid REFERENCES users (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ledger_entries_idempotency_key_key UNIQUE (idempotency_key),
    CONSTRAINT ledger_entries_kind_check CHECK (
        kind IN ('rent', 'late_fee', 'other_charge', 'deposit_charge', 'payment', 'credit', 'reversal')
    ),
    CONSTRAINT ledger_entries_amount_sign_check CHECK (
        amount_cents <> 0 AND (
            (kind IN ('rent', 'late_fee', 'other_charge', 'deposit_charge') AND amount_cents > 0)
            OR (kind IN ('payment', 'credit') AND amount_cents < 0)
            OR kind = 'reversal'
        )
    ),
    CONSTRAINT ledger_entries_period_check CHECK (
        (kind IN ('rent', 'late_fee')) = (period IS NOT NULL)
        AND (period IS NULL OR period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
    ),
    CONSTRAINT ledger_entries_reversal_check CHECK ((kind = 'reversal') = (reverses_entry_id IS NOT NULL))
);

CREATE UNIQUE INDEX ledger_entries_reverses_entry_id_key ON ledger_entries (reverses_entry_id)
    WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX ledger_entries_lease_date_idx ON ledger_entries (lease_id, entry_date, id);

-- +goose StatementBegin
CREATE FUNCTION ledger_entries_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION ledger_entries_check_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target ledger_entries%ROWTYPE;
BEGIN
    IF NEW.kind <> 'reversal' THEN
        RETURN NEW;
    END IF;
    SELECT * INTO target FROM ledger_entries WHERE id = NEW.reverses_entry_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'reversed entry % does not exist', NEW.reverses_entry_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF target.kind = 'reversal' THEN
        RAISE EXCEPTION 'entry % is a reversal and cannot be reversed', target.id
            USING ERRCODE = 'check_violation';
    END IF;
    IF target.lease_id <> NEW.lease_id OR NEW.amount_cents <> -target.amount_cents THEN
        RAISE EXCEPTION 'reversal must negate entry % on the same lease', target.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();

CREATE TRIGGER ledger_entries_check_reversal
    BEFORE INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_check_reversal();

-- +goose Down
DROP TABLE ledger_entries;
DROP FUNCTION ledger_entries_check_reversal();
DROP FUNCTION ledger_entries_append_only();
