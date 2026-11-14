CREATE TABLE issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'backlog',
  priority smallint NOT NULL DEFAULT 0,
  assignee_id uuid,
  reporter_id uuid NOT NULL REFERENCES users (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', title), 'A') ||
    setweight(to_tsvector('english', description), 'B')
  ) STORED,
  CONSTRAINT issues_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT issues_project_id_number_key UNIQUE (project_id, number),
  CONSTRAINT issues_project_fkey FOREIGN KEY (org_id, project_id)
    REFERENCES projects (org_id, id) ON DELETE CASCADE,
  CONSTRAINT issues_assignee_fkey FOREIGN KEY (org_id, assignee_id)
    REFERENCES memberships (org_id, user_id),
  CONSTRAINT issues_number_positive CHECK (number >= 1),
  CONSTRAINT issues_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT issues_description_length CHECK (char_length(description) <= 20000),
  CONSTRAINT issues_status_check
    CHECK (status IN ('backlog', 'todo', 'in_progress', 'done', 'cancelled')),
  CONSTRAINT issues_priority_range CHECK (priority BETWEEN 0 AND 4),
  CONSTRAINT issues_version_positive CHECK (version >= 1)
);

CREATE INDEX issues_created_order_idx ON issues (org_id, project_id, created_at DESC, id DESC);
CREATE INDEX issues_updated_order_idx ON issues (org_id, project_id, updated_at DESC, id DESC);
CREATE INDEX issues_priority_order_idx ON issues (org_id, project_id, priority DESC, id DESC);
CREATE INDEX issues_org_assignee_idx ON issues (org_id, assignee_id);
CREATE INDEX issues_search_idx ON issues USING gin (search);

CREATE TABLE issue_labels (
  org_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  label_id uuid NOT NULL,
  PRIMARY KEY (org_id, issue_id, label_id),
  CONSTRAINT issue_labels_issue_fkey FOREIGN KEY (org_id, issue_id)
    REFERENCES issues (org_id, id) ON DELETE CASCADE,
  CONSTRAINT issue_labels_label_fkey FOREIGN KEY (org_id, label_id)
    REFERENCES labels (org_id, id) ON DELETE CASCADE
);

CREATE INDEX issue_labels_label_idx ON issue_labels (org_id, label_id);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users (id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  CONSTRAINT comments_issue_fkey FOREIGN KEY (org_id, issue_id)
    REFERENCES issues (org_id, id) ON DELETE CASCADE,
  CONSTRAINT comments_body_length CHECK (char_length(body) BETWEEN 1 AND 10000)
);

CREATE INDEX comments_issue_order_idx ON comments (org_id, issue_id, created_at, id);
