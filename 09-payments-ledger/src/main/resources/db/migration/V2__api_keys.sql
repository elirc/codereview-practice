CREATE TABLE api_keys (
    id         uuid PRIMARY KEY,
    name       text        NOT NULL,
    key_hash   text        NOT NULL,
    role       text        NOT NULL,
    owner_id   uuid,
    created_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash),
    CONSTRAINT api_keys_role_check CHECK (role IN ('service', 'merchant', 'operator', 'auditor')),
    CONSTRAINT api_keys_owner_check CHECK ((role = 'merchant') = (owner_id IS NOT NULL))
);

ALTER TABLE journal_entries
    ADD CONSTRAINT journal_entries_actor_key_id_fkey FOREIGN KEY (actor_key_id) REFERENCES api_keys (id);
