CREATE TABLE workflow_definitions (
    id         uuid        PRIMARY KEY,
    name       text        NOT NULL CHECK (name ~ '^[a-z0-9_-]{1,64}$'),
    version    integer     NOT NULL CHECK (version >= 1),
    steps      jsonb       NOT NULL,
    queues     text[]      NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT workflow_definitions_name_version_key UNIQUE (name, version)
);

CREATE TABLE workflow_runs (
    id                  uuid        PRIMARY KEY,
    definition_id       uuid        NOT NULL REFERENCES workflow_definitions (id),
    state               text        NOT NULL
        CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled')),
    input               jsonb       NOT NULL,
    cancel_requested    boolean     NOT NULL DEFAULT false,
    created_by_token_id uuid        REFERENCES api_tokens (id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL,
    finished_at         timestamptz,
    CONSTRAINT workflow_runs_finished_consistency CHECK ((state = 'running') = (finished_at IS NULL))
);

CREATE INDEX workflow_runs_listing_idx ON workflow_runs (created_at DESC, id DESC);
CREATE INDEX workflow_runs_finished_idx ON workflow_runs (finished_at) WHERE state <> 'running';

CREATE TABLE workflow_steps (
    run_id   uuid  NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    step_key text  NOT NULL,
    state    text  NOT NULL
        CHECK (state IN ('blocked', 'queued', 'succeeded', 'failed', 'skipped', 'cancelled')),
    job_id   uuid,
    output   jsonb,
    PRIMARY KEY (run_id, step_key),
    CONSTRAINT workflow_steps_queued_has_job CHECK (state <> 'queued' OR job_id IS NOT NULL)
);

ALTER TABLE jobs
    ADD CONSTRAINT jobs_workflow_run_fkey FOREIGN KEY (workflow_run_id)
        REFERENCES workflow_runs (id) ON DELETE CASCADE;

CREATE UNIQUE INDEX jobs_workflow_step_key ON jobs (workflow_run_id, step_key)
    WHERE workflow_run_id IS NOT NULL;

ALTER TABLE workflow_steps
    ADD CONSTRAINT workflow_steps_job_fkey FOREIGN KEY (job_id)
        REFERENCES jobs (id) ON DELETE SET NULL;
