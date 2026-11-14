export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'done' | 'cancelled';
export type IssueSort = 'created' | 'updated' | 'priority';

export const STATUSES: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'done', 'cancelled'];
export const ROLES: Role[] = ['viewer', 'member', 'admin', 'owner'];
export const PRIORITY_LABELS = ['None', 'Low', 'Medium', 'High', 'Urgent'];

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface MembershipSummary {
  orgSlug: string;
  orgName: string;
  role: Role;
}

export interface Me {
  user: User;
  memberships: MembershipSummary[];
}

export interface Org {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface UserSummary {
  id: string;
  name: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface IssueSummary {
  id: string;
  identifier: string;
  projectKey: string;
  number: number;
  title: string;
  status: IssueStatus;
  priority: number;
  assignee: UserSummary | null;
  labels: Label[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssueDetail extends IssueSummary {
  description: string;
  reporter: UserSummary;
}

export interface Comment {
  id: string;
  body: string;
  author: UserSummary;
  createdAt: string;
  editedAt: string | null;
  /** Set on a comment that is shown before the server has confirmed it. */
  pending?: boolean;
}

export interface IssueFilters {
  projectKey?: string;
  status?: IssueStatus[];
  assigneeId?: string;
  labelId?: string[];
  q?: string;
  sort?: IssueSort;
}

export interface IssuePatch {
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: number;
  assigneeId?: string | null;
  projectKey?: string;
}
