-- +goose Up
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION ledger_entries_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW.id = OLD.id
        AND NEW.entry_date = OLD.entry_date
        AND NEW.kind = OLD.kind
        AND NEW.amount_cents = OLD.amount_cents
        AND NEW.period IS NOT DISTINCT FROM OLD.period
        AND NEW.reverses_entry_id IS NOT DISTINCT FROM OLD.reverses_entry_id
        AND NEW.idempotency_key = OLD.idempotency_key
        AND NEW.created_at = OLD.created_at THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP;
END;
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION ledger_entries_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP;
END;
$$;
-- +goose StatementEnd
