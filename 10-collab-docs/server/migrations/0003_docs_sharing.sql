create table docs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  title text not null,
  owner_id uuid not null,
  workspace_access text not null default 'none',
  head_seq bigint not null default 0,
  snapshot_seq bigint not null default 0,
  log_bytes bigint not null default 0,
  snapshot_bytes bigint not null default 0,
  perm_epoch bigint not null default 0,
  trashed_at timestamptz,
  trashed_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint docs_title_length check (char_length(title) between 1 and 200),
  constraint docs_workspace_access check (workspace_access in ('none', 'viewer', 'commenter', 'editor')),
  constraint docs_seq_order check (head_seq >= snapshot_seq and snapshot_seq >= 0),
  constraint docs_bytes_nonnegative check (log_bytes >= 0 and snapshot_bytes >= 0),
  constraint docs_perm_epoch_nonnegative check (perm_epoch >= 0),
  constraint docs_trash_fields check ((trashed_at is null) = (trashed_by is null)),
  constraint docs_owner_is_member foreign key (workspace_id, owner_id)
    references workspace_members (workspace_id, user_id)
);

create index docs_workspace_id_idx on docs (workspace_id);
create index docs_owner_id_idx on docs (owner_id);
create index docs_trashed_at_idx on docs (trashed_at) where trashed_at is not null;

create table doc_shares (
  doc_id uuid not null references docs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (doc_id, user_id),
  constraint doc_shares_role check (role in ('viewer', 'commenter', 'editor'))
);

create index doc_shares_user_id_idx on doc_shares (user_id);

create table doc_links (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references docs (id) on delete cascade,
  token_hash text not null,
  role text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  constraint doc_links_role check (role in ('viewer', 'commenter', 'editor'))
);

create unique index doc_links_token_hash_key on doc_links (token_hash);
create index doc_links_doc_id_idx on doc_links (doc_id);
