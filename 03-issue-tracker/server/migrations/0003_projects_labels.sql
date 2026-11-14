CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  next_issue_number integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT projects_org_id_key_key UNIQUE (org_id, key),
  CONSTRAINT projects_key_format CHECK (key ~ '^[A-Z]{2,6}$'),
  CONSTRAINT projects_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT projects_next_issue_number_positive CHECK (next_issue_number >= 1)
);

CREATE TABLE labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT labels_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT labels_name_length CHECK (char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT labels_color_format CHECK (color ~ '^#[0-9a-f]{6}$')
);

CREATE UNIQUE INDEX labels_org_id_name_key ON labels (org_id, lower(name));
