import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

export type WorkspaceRoleColumn = 'owner' | 'admin' | 'member';
export type ShareRoleColumn = 'viewer' | 'commenter' | 'editor';
export type WorkspaceAccessColumn = 'none' | 'viewer' | 'commenter' | 'editor';
export type VersionKindColumn = 'auto' | 'named' | 'pre_restore';
export type ThreadStatusColumn = 'open' | 'resolved';

/** A timestamptz column with a database default that may also be set explicitly. */
type CreatedAt = ColumnType<Date, Date | undefined, Date>;
/** A bigint column (parsed to number) with a database default. */
type Counter = ColumnType<number, number | undefined, number>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  password_hash: string;
  created_at: CreatedAt;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: CreatedAt;
}

export interface WorkspacesTable {
  id: Generated<string>;
  name: string;
  allow_external_sharing: ColumnType<boolean, boolean | undefined, boolean>;
  perm_epoch: Counter;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

export interface WorkspaceMembersTable {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRoleColumn;
  created_at: CreatedAt;
}

export interface DocsTable {
  id: Generated<string>;
  workspace_id: string;
  title: string;
  owner_id: string;
  workspace_access: ColumnType<WorkspaceAccessColumn, WorkspaceAccessColumn | undefined>;
  head_seq: Counter;
  snapshot_seq: Counter;
  log_bytes: Counter;
  snapshot_bytes: Counter;
  perm_epoch: Counter;
  trashed_at: Date | null;
  trashed_by: string | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

export interface DocSharesTable {
  doc_id: string;
  user_id: string;
  role: ShareRoleColumn;
  created_at: CreatedAt;
}

export interface DocLinksTable {
  id: Generated<string>;
  doc_id: string;
  token_hash: string;
  role: ShareRoleColumn;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by: string;
  created_at: CreatedAt;
}

export interface DocUpdatesTable {
  doc_id: string;
  seq: number;
  update: Buffer;
  user_id: string | null;
  created_at: CreatedAt;
}

export interface DocSnapshotsTable {
  doc_id: string;
  upto_seq: number;
  state: Buffer;
  created_at: CreatedAt;
}

export interface DocVersionsTable {
  id: Generated<string>;
  doc_id: string;
  seq: number;
  state: Buffer;
  kind: VersionKindColumn;
  label: string | null;
  created_by: string | null;
  created_at: CreatedAt;
}

export interface CommentThreadsTable {
  id: Generated<string>;
  doc_id: string;
  anchor_start: Buffer;
  anchor_end: Buffer;
  quoted_text: string;
  status: ColumnType<ThreadStatusColumn, ThreadStatusColumn | undefined>;
  created_by: string;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: CreatedAt;
}

export interface CommentsTable {
  id: Generated<string>;
  thread_id: string;
  author_id: string;
  body: string;
  created_at: CreatedAt;
  edited_at: Date | null;
  deleted_at: Date | null;
}

export interface DB {
  users: UsersTable;
  sessions: SessionsTable;
  workspaces: WorkspacesTable;
  workspace_members: WorkspaceMembersTable;
  docs: DocsTable;
  doc_shares: DocSharesTable;
  doc_links: DocLinksTable;
  doc_updates: DocUpdatesTable;
  doc_snapshots: DocSnapshotsTable;
  doc_versions: DocVersionsTable;
  comment_threads: CommentThreadsTable;
  comments: CommentsTable;
}

export type UserRow = Selectable<UsersTable>;
export type DocRow = Selectable<DocsTable>;
export type DocLinkRow = Selectable<DocLinksTable>;
export type DocVersionRow = Selectable<DocVersionsTable>;
export type CommentThreadRow = Selectable<CommentThreadsTable>;
export type CommentRow = Selectable<CommentsTable>;
export type NewDocUpdate = Insertable<DocUpdatesTable>;
