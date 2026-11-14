CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orgs_slug_key UNIQUE (slug),
  CONSTRAINT orgs_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  CONSTRAINT orgs_name_length CHECK (char_length(name) BETWEEN 1 AND 100)
);

CREATE TABLE memberships (
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);

CREATE INDEX memberships_user_id_idx ON memberships (user_id);
CREATE INDEX memberships_org_joined_idx ON memberships (org_id, created_at, user_id);
