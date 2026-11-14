CREATE TABLE schedules (
    id           uuid        PRIMARY KEY,
    name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    cron_expr    text        NOT NULL CHECK (char_length(cron_expr) BETWEEN 1 AND 200),
    queue        text        NOT NULL,
    kind         text        NOT NULL CHECK (kind ~ '^[a-z0-9_.]{1,64}$'),
    payload      jsonb       NOT NULL DEFAULT '{}',
    priority     integer     NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
    catchup      text        NOT NULL DEFAULT 'skip' CHECK (catchup IN ('skip', 'latest', 'all')),
    max_catchup  integer     NOT NULL DEFAULT 10 CHECK (max_catchup BETWEEN 1 AND 100),
    paused       boolean     NOT NULL DEFAULT false,
    next_fire_at timestamptz NOT NULL,
    last_fire_at timestamptz,
    created_at   timestamptz NOT NULL,
    CONSTRAINT schedules_name_key UNIQUE (name),
    CONSTRAINT schedules_queue_fkey FOREIGN KEY (queue) REFERENCES queues (name)
);

CREATE INDEX schedules_due_idx ON schedules (next_fire_at) WHERE NOT paused;

ALTER TABLE jobs
    ADD CONSTRAINT jobs_schedule_fkey FOREIGN KEY (schedule_id)
        REFERENCES schedules (id) ON DELETE SET NULL;

CREATE INDEX jobs_schedule_idx ON jobs (schedule_id) WHERE schedule_id IS NOT NULL;
