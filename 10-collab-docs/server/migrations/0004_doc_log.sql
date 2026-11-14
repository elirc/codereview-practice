create table doc_updates (
  doc_id uuid not null references docs (id) on delete cascade,
  seq bigint not null,
  "update" bytea not null,
  user_id uuid references users (id),
  created_at timestamptz not null default now(),
  primary key (doc_id, seq),
  constraint doc_updates_seq_positive check (seq > 0),
  constraint doc_updates_size check (octet_length("update") <= 262144)
);

create table doc_snapshots (
  doc_id uuid not null references docs (id) on delete cascade,
  upto_seq bigint not null,
  state bytea not null,
  created_at timestamptz not null default now(),
  primary key (doc_id, upto_seq),
  constraint doc_snapshots_upto_seq_positive check (upto_seq > 0)
);

create table doc_versions (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references docs (id) on delete cascade,
  seq bigint not null,
  state bytea not null,
  kind text not null,
  label text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  constraint doc_versions_seq_nonnegative check (seq >= 0),
  constraint doc_versions_kind check (kind in ('auto', 'named', 'pre_restore')),
  constraint doc_versions_label_length check (label is null or char_length(label) between 1 and 100),
  constraint doc_versions_named_label check (kind <> 'named' or label is not null)
);

create unique index doc_versions_auto_seq_key on doc_versions (doc_id, seq) where kind = 'auto';
create index doc_versions_doc_created_idx on doc_versions (doc_id, created_at desc);
