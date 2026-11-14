-- +goose Up
CREATE TABLE job_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job text NOT NULL,
    as_of date NOT NULL,
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    status text NOT NULL,
    leases_processed integer NOT NULL DEFAULT 0,
    entries_posted integer NOT NULL DEFAULT 0,
    errors jsonb NOT NULL DEFAULT '[]'::jsonb,
    CONSTRAINT job_runs_job_check CHECK (job IN ('post-rent', 'assess-late-fees')),
    CONSTRAINT job_runs_status_check CHECK (status IN ('running', 'ok', 'partial', 'failed')),
    CONSTRAINT job_runs_finished_check CHECK ((status = 'running') = (finished_at IS NULL)),
    CONSTRAINT job_runs_errors_check CHECK (jsonb_typeof(errors) = 'array')
);

CREATE INDEX job_runs_job_as_of_idx ON job_runs (job, as_of);
CREATE INDEX job_runs_started_at_idx ON job_runs (started_at DESC);

-- +goose Down
DROP TABLE job_runs;
