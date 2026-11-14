-- Accounts, balances, the journal and the outbox.

CREATE TABLE accounts (
    id                uuid PRIMARY KEY,
    owner_id          uuid,
    type              text        NOT NULL,
    system_role       text,
    currency          text        NOT NULL,
    status            text        NOT NULL DEFAULT 'active',
    allow_negative    boolean     NOT NULL,
    deposit_reference text,
    fee_bps           integer,
    payout_enabled    boolean,
    created_at        timestamptz NOT NULL,
    CONSTRAINT accounts_type_check CHECK (type IN ('customer_wallet', 'merchant', 'system')),
    CONSTRAINT accounts_system_role_check CHECK (
        system_role IN ('bank_cash', 'payout_clearing', 'fx_position', 'fx_residue', 'fees', 'suspense')
    ),
    CONSTRAINT accounts_currency_check CHECK (currency IN ('USD', 'EUR', 'GBP', 'JPY', 'KWD')),
    CONSTRAINT accounts_status_check CHECK (status IN ('active', 'frozen', 'closed')),
    CONSTRAINT accounts_fee_bps_check CHECK (fee_bps BETWEEN 0 AND 1000),
    CONSTRAINT accounts_deposit_reference_key UNIQUE (deposit_reference),
    CONSTRAINT accounts_owner_type_currency_key UNIQUE (owner_id, type, currency),
    CONSTRAINT accounts_system_role_currency_key UNIQUE (system_role, currency),
    CONSTRAINT accounts_shape_check CHECK (
        (type = 'system'
            AND owner_id IS NULL AND system_role IS NOT NULL AND allow_negative
            AND deposit_reference IS NULL AND fee_bps IS NULL AND payout_enabled IS NULL)
        OR (type = 'customer_wallet'
            AND owner_id IS NOT NULL AND system_role IS NULL AND NOT allow_negative
            AND deposit_reference IS NOT NULL AND fee_bps IS NULL AND payout_enabled IS NULL)
        OR (type = 'merchant'
            AND owner_id IS NOT NULL AND system_role IS NULL AND NOT allow_negative
            AND deposit_reference IS NOT NULL AND fee_bps IS NOT NULL AND payout_enabled IS NOT NULL)
    )
);

CREATE INDEX accounts_owner_idx ON accounts (owner_id);
CREATE INDEX accounts_type_currency_idx ON accounts (type, currency, id);

CREATE TABLE account_balances (
    account_id     uuid PRIMARY KEY REFERENCES accounts (id),
    posted_minor   bigint  NOT NULL DEFAULT 0,
    held_minor     bigint  NOT NULL DEFAULT 0,
    version        bigint  NOT NULL DEFAULT 0,
    allow_negative boolean NOT NULL,
    CONSTRAINT account_balances_held_check CHECK (held_minor >= 0),
    CONSTRAINT account_balances_available_check CHECK (allow_negative OR posted_minor - held_minor >= 0)
);

CREATE TABLE journal_entries (
    id                uuid PRIMARY KEY,
    sequence          bigint GENERATED ALWAYS AS IDENTITY,
    kind              text        NOT NULL,
    reverses_entry_id uuid REFERENCES journal_entries (id),
    reason            text,
    actor_key_id      uuid,
    request_id        text        NOT NULL,
    created_at        timestamptz NOT NULL,
    CONSTRAINT journal_entries_sequence_key UNIQUE (sequence),
    CONSTRAINT journal_entries_reverses_entry_id_key UNIQUE (reverses_entry_id),
    CONSTRAINT journal_entries_kind_check CHECK (kind IN (
        'deposit', 'withdrawal', 'transfer', 'capture', 'fx_transfer', 'settlement',
        'bank_match', 'payout_return', 'suspense', 'reversal'
    )),
    CONSTRAINT journal_entries_reversal_check CHECK ((kind = 'reversal') = (reverses_entry_id IS NOT NULL))
);

CREATE TABLE postings (
    entry_id     uuid    NOT NULL REFERENCES journal_entries (id),
    line_no      integer NOT NULL,
    account_id   uuid    NOT NULL REFERENCES accounts (id),
    amount_minor bigint  NOT NULL,
    currency     text    NOT NULL,
    CONSTRAINT postings_pkey PRIMARY KEY (entry_id, line_no),
    CONSTRAINT postings_line_no_check CHECK (line_no >= 1),
    CONSTRAINT postings_amount_check CHECK (amount_minor <> 0)
);

CREATE INDEX postings_account_idx ON postings (account_id);

-- Journal rows are append-only.
CREATE FUNCTION reject_journal_change() RETURNS trigger
    LANGUAGE plpgsql AS
$$
BEGIN
    RAISE EXCEPTION '% rows cannot be updated or deleted', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER journal_entries_append_only
    BEFORE UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION reject_journal_change();

CREATE TRIGGER postings_append_only
    BEFORE UPDATE OR DELETE ON postings
    FOR EACH ROW EXECUTE FUNCTION reject_journal_change();

-- A posting's currency must be its account's currency.
CREATE FUNCTION check_posting_currency() RETURNS trigger
    LANGUAGE plpgsql AS
$$
DECLARE
    account_currency text;
BEGIN
    SELECT currency INTO account_currency FROM accounts WHERE id = NEW.account_id;
    IF account_currency IS DISTINCT FROM NEW.currency THEN
        RAISE EXCEPTION 'posting currency % does not match account % currency %',
            NEW.currency, NEW.account_id, account_currency
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER postings_currency_matches_account
    BEFORE INSERT ON postings
    FOR EACH ROW EXECUTE FUNCTION check_posting_currency();

-- Checked at commit: every entry has two or more postings that sum to zero per currency.
CREATE FUNCTION check_entry_balanced(p_entry_id uuid) RETURNS void
    LANGUAGE plpgsql AS
$$
DECLARE
    line_count          integer;
    unbalanced_currency text;
BEGIN
    SELECT count(*) INTO line_count FROM postings WHERE entry_id = p_entry_id;
    IF line_count < 2 THEN
        RAISE EXCEPTION 'journal entry % has % postings; at least two are required', p_entry_id, line_count
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT currency INTO unbalanced_currency
    FROM postings
    WHERE entry_id = p_entry_id
    GROUP BY currency
    HAVING sum(amount_minor) <> 0
    LIMIT 1;

    IF unbalanced_currency IS NOT NULL THEN
        RAISE EXCEPTION 'journal entry % does not balance in %', p_entry_id, unbalanced_currency
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

CREATE FUNCTION check_posting_entry_balanced() RETURNS trigger
    LANGUAGE plpgsql AS
$$
BEGIN
    PERFORM check_entry_balanced(NEW.entry_id);
    RETURN NULL;
END
$$;

CREATE FUNCTION check_new_entry_balanced() RETURNS trigger
    LANGUAGE plpgsql AS
$$
BEGIN
    PERFORM check_entry_balanced(NEW.id);
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER postings_entry_balanced
    AFTER INSERT ON postings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_posting_entry_balanced();

CREATE CONSTRAINT TRIGGER journal_entries_balanced
    AFTER INSERT ON journal_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_new_entry_balanced();

CREATE TABLE outbox (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id      uuid        NOT NULL,
    topic         text        NOT NULL,
    partition_key text        NOT NULL,
    payload       jsonb       NOT NULL,
    created_at    timestamptz NOT NULL,
    published_at  timestamptz,
    attempts      integer     NOT NULL DEFAULT 0,
    last_error    text,
    CONSTRAINT outbox_event_id_key UNIQUE (event_id)
);

CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX outbox_published_at_idx ON outbox (published_at) WHERE published_at IS NOT NULL;

-- One system account per role and supported currency.
INSERT INTO accounts (id, owner_id, type, system_role, currency, status, allow_negative, created_at)
SELECT gen_random_uuid(), NULL, 'system', r.role, c.code, 'active', true, now()
FROM (VALUES ('bank_cash'), ('payout_clearing'), ('fx_position'), ('fx_residue'), ('fees'), ('suspense')) AS r (role)
CROSS JOIN (VALUES ('USD'), ('EUR'), ('GBP'), ('JPY'), ('KWD')) AS c (code);

INSERT INTO account_balances (account_id, posted_minor, held_minor, version, allow_negative)
SELECT id, 0, 0, 0, true
FROM accounts
WHERE type = 'system';
