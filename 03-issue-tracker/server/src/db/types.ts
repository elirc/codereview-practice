import type { ColumnType, Generated, GeneratedAlways } from 'kysely';

/** Hand-maintained to match server/migrations. */

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type DefaultedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';
export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'done' | 'cancelled';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  password_hash: string;
  created_at: DefaultedTimestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  created_at: DefaultedTimestamp;
}

export interface OrgsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  created_at: DefaultedTimestamp;
}

export interface MembershipsTable {
  org_id: string;
  user_id: string;
  role: MembershipRole;
  created_at: DefaultedTimestamp;
}

export interface ProjectsTable {
  id: Generated<string>;
  org_id: string;
  key: string;
  name: string;
  next_issue_number: Generated<number>;
  archived_at: NullableTimestamp;
  created_at: DefaultedTimestamp;
}

export interface LabelsTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  color: string;
  created_at: DefaultedTimestamp;
}

export interface IssuesTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  number: number;
  title: string;
  description: Generated<string>;
  status: Generated<IssueStatus>;
  priority: Generated<number>;
  assignee_id: string | null;
  reporter_id: string;
  version: Generated<number>;
  created_at: DefaultedTimestamp;
  updated_at: DefaultedTimestamp;
  search: GeneratedAlways<string>;
}

export interface IssueLabelsTable {
  org_id: string;
  issue_id: string;
  label_id: string;
}

export interface CommentsTable {
  id: Generated<string>;
  org_id: string;
  issue_id: string;
  author_id: string;
  body: string;
  created_at: DefaultedTimestamp;
  edited_at: NullableTimestamp;
}

export interface DB {
  users: UsersTable;
  sessions: SessionsTable;
  orgs: OrgsTable;
  memberships: MembershipsTable;
  projects: ProjectsTable;
  labels: LabelsTable;
  issues: IssuesTable;
  issue_labels: IssueLabelsTable;
  comments: CommentsTable;
}
