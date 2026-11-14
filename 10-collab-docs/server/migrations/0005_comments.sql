create table comment_threads (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references docs (id) on delete cascade,
  anchor_start bytea not null,
  anchor_end bytea not null,
  quoted_text text not null,
  status text not null default 'open',
  created_by uuid not null references users (id),
  resolved_by uuid references users (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint comment_threads_quoted_length check (char_length(quoted_text) <= 200),
  constraint comment_threads_status check (status in ('open', 'resolved')),
  constraint comment_threads_resolution check (
    (status = 'resolved') = (resolved_at is not null and resolved_by is not null)
  )
);

create index comment_threads_doc_id_idx on comment_threads (doc_id, created_at);

create table comments (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references comment_threads (id) on delete cascade,
  author_id uuid not null references users (id),
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint comments_body_length check (char_length(body) <= 4000),
  constraint comments_body_present check (deleted_at is not null or char_length(body) >= 1),
  constraint comments_deleted_blank check (deleted_at is null or body = '')
);

create index comments_thread_id_idx on comments (thread_id, created_at);
