create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  constraint users_email_lower check (email = lower(email)),
  constraint users_email_length check (char_length(email) between 3 and 254),
  constraint users_name_length check (char_length(name) between 1 and 100)
);

create unique index users_email_key on users (email);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index sessions_token_hash_key on sessions (token_hash);
create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);
