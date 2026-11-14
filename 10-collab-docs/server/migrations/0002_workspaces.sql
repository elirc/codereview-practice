create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  allow_external_sharing boolean not null default false,
  perm_epoch bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_name_length check (char_length(name) between 1 and 100),
  constraint workspaces_perm_epoch_nonnegative check (perm_epoch >= 0)
);

create table workspace_members (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  constraint workspace_members_role check (role in ('owner', 'admin', 'member'))
);

create unique index workspace_members_one_owner on workspace_members (workspace_id)
  where role = 'owner';
create index workspace_members_user_id_idx on workspace_members (user_id);
