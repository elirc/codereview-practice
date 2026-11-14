CREATE TABLE queues (
    name                  text        PRIMARY KEY CHECK (name ~ '^[a-z0-9_-]{1,64}$'),
    paused                boolean     NOT NULL DEFAULT false,
    max_concurrency       integer     CHECK (max_concurrency >= 1),
    rate_limit_per_minute integer     CHECK (rate_limit_per_minute >= 1),
    rate_burst            integer     CHECK (rate_burst >= 1),
    rate_tokens_milli     bigint      NOT NULL DEFAULT 0 CHECK (rate_tokens_milli >= 0),
    rate_refilled_at      timestamptz NOT NULL,
    default_max_attempts  integer     NOT NULL DEFAULT 5 CHECK (default_max_attempts BETWEEN 1 AND 50),
    default_lease_seconds integer     NOT NULL DEFAULT 60 CHECK (default_lease_seconds BETWEEN 5 AND 3600),
    backoff_base_ms       bigint      NOT NULL DEFAULT 1000 CHECK (backoff_base_ms >= 1),
    backoff_cap_ms        bigint      NOT NULL DEFAULT 3600000,
    created_at            timestamptz NOT NULL,
    CONSTRAINT queues_rate_limit_pair CHECK ((rate_limit_per_minute IS NULL) = (rate_burst IS NULL)),
    CONSTRAINT queues_backoff_order CHECK (backoff_cap_ms >= backoff_base_ms)
);

CREATE TABLE api_tokens (
    id          uuid        PRIMARY KEY,
    name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    token_hash  text        NOT NULL,
    role        text        NOT NULL CHECK (role IN ('viewer', 'submitter', 'operator', 'admin')),
    queues      text[]      NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash)
);

CREATE TABLE jobs (
    id                  uuid        PRIMARY KEY,
    queue               text        NOT NULL,
    kind                text        NOT NULL CHECK (kind ~ '^[a-z0-9_.]{1,64}$'),
    payload             jsonb       NOT NULL,
    priority            integer     NOT NULL DEFAULT 5,
    state               text        NOT NULL,
    run_at              timestamptz NOT NULL,
    attempt             integer     NOT NULL DEFAULT 0,
    max_attempts        integer     NOT NULL CHECK (max_attempts BETWEEN 1 AND 50),
    lease_seconds       integer     NOT NULL CHECK (lease_seconds BETWEEN 5 AND 3600),
    lease_epoch         bigint      NOT NULL DEFAULT 0,
    lease_owner         text,
    lease_expires_at    timestamptz,
    heartbeat_at        timestamptz,
    cancel_requested    boolean     NOT NULL DEFAULT false,
    unique_key          text        CHECK (char_length(unique_key) BETWEEN 1 AND 200),
    result              jsonb,
    last_error          text        CHECK (char_length(last_error) <= 2000),
    dead_reason         text        CHECK (dead_reason IN ('attempts_exhausted', 'permanent_failure', 'lease_expired')),
    schedule_id         uuid,
    scheduled_for       timestamptz,
    workflow_run_id     uuid,
    step_key            text,
    created_by_token_id uuid,
    created_at          timestamptz NOT NULL,
    started_at          timestamptz,
    finished_at         timestamptz,
    CONSTRAINT jobs_queue_fkey FOREIGN KEY (queue) REFERENCES queues (name),
    CONSTRAINT jobs_created_by_token_fkey FOREIGN KEY (created_by_token_id)
        REFERENCES api_tokens (id) ON DELETE SET NULL,
    CONSTRAINT jobs_state_check
        CHECK (state IN ('pending', 'running', 'succeeded', 'dead', 'cancelled')),
    CONSTRAINT jobs_priority_check CHECK (priority BETWEEN 0 AND 9),
    CONSTRAINT jobs_attempt_check CHECK (attempt >= 0),
    CONSTRAINT jobs_lease_consistency
        CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CONSTRAINT jobs_dead_reason_consistency CHECK ((state = 'dead') = (dead_reason IS NOT NULL)),
    CONSTRAINT jobs_finished_consistency
        CHECK ((state IN ('succeeded', 'dead', 'cancelled')) = (finished_at IS NOT NULL)),
    CONSTRAINT jobs_workflow_pair CHECK ((workflow_run_id IS NULL) = (step_key IS NULL))
);

CREATE INDEX jobs_claim_idx ON jobs (queue, priority DESC, run_at, id) WHERE state = 'pending';
CREATE INDEX jobs_lease_expiry_idx ON jobs (lease_expires_at) WHERE state = 'running';
CREATE UNIQUE INDEX jobs_live_unique_key ON jobs (queue, unique_key)
    WHERE unique_key IS NOT NULL AND state IN ('pending', 'running');
CREATE INDEX jobs_listing_idx ON jobs (created_at DESC, id DESC);
CREATE INDEX jobs_queue_state_idx ON jobs (queue, state);
CREATE INDEX jobs_finished_idx ON jobs (finished_at) WHERE state IN ('succeeded', 'dead', 'cancelled');

CREATE TABLE job_attempts (
    job_id      uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    attempt     integer     NOT NULL CHECK (attempt >= 1),
    lease_epoch bigint      NOT NULL,
    worker_id   text        NOT NULL,
    started_at  timestamptz NOT NULL,
    finished_at timestamptz,
    outcome     text        CHECK (outcome IN ('succeeded', 'retryable_error', 'permanent_error',
                                               'lease_expired', 'released', 'cancelled')),
    error       text        CHECK (char_length(error) <= 2000),
    PRIMARY KEY (job_id, lease_epoch)
);
