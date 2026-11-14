import { api } from './client';
import type {
  Comment,
  IssueDetail,
  IssueFilters,
  IssuePatch,
  IssueStatus,
  IssueSummary,
  Label,
  Me,
  Member,
  Org,
  Page,
  Project,
  Role,
} from './types';

const enc = encodeURIComponent;

function issuePath(slug: string, projectKey: string, number: number): string {
  return `/orgs/${enc(slug)}/projects/${enc(projectKey)}/issues/${number}`;
}

function issueQuery(filters: IssueFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.projectKey) params.set('projectKey', filters.projectKey);
  for (const status of filters.status ?? []) params.append('status', status);
  if (filters.assigneeId) params.set('assigneeId', filters.assigneeId);
  for (const labelId of filters.labelId ?? []) params.append('labelId', labelId);
  if (filters.q) params.set('q', filters.q);
  if (filters.sort) params.set('sort', filters.sort);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function cursorQuery(cursor: string | null, limit?: number): string {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Methods are looked up on this object at call time so tests can spy on them. */
export const endpoints = {
  me: () => api.get<Me>('/auth/me'),
  login: (body: { email: string; password: string }) => api.post<Me>('/auth/login', body),
  register: (body: { email: string; name: string; password: string }) =>
    api.post<Me>('/auth/register', body),
  logout: () => api.post<void>('/auth/logout'),

  createOrg: (body: { slug: string; name: string }) => api.post<Org>('/orgs', body),
  getOrg: (slug: string) => api.get<Org>(`/orgs/${enc(slug)}`),

  listProjects: (slug: string) => api.get<{ items: Project[] }>(`/orgs/${enc(slug)}/projects`),
  createProject: (slug: string, body: { key: string; name: string }) =>
    api.post<Project>(`/orgs/${enc(slug)}/projects`, body),
  renameProject: (slug: string, key: string, name: string) =>
    api.patch<Project>(`/orgs/${enc(slug)}/projects/${enc(key)}`, { name }),
  archiveProject: (slug: string, key: string) =>
    api.post<Project>(`/orgs/${enc(slug)}/projects/${enc(key)}/archive`),

  listLabels: (slug: string) => api.get<{ items: Label[] }>(`/orgs/${enc(slug)}/labels`),
  createLabel: (slug: string, body: { name: string; color: string }) =>
    api.post<Label>(`/orgs/${enc(slug)}/labels`, body),
  updateLabel: (slug: string, id: string, body: { name?: string; color?: string }) =>
    api.patch<Label>(`/orgs/${enc(slug)}/labels/${id}`, body),
  deleteLabel: (slug: string, id: string) => api.delete(`/orgs/${enc(slug)}/labels/${id}`),

  listMembers: (slug: string, cursor: string | null, limit?: number) =>
    api.get<Page<Member>>(`/orgs/${enc(slug)}/members${cursorQuery(cursor, limit)}`),
  addMember: (slug: string, body: { email: string; role: Role }) =>
    api.post<Member>(`/orgs/${enc(slug)}/members`, body),
  changeRole: (slug: string, userId: string, role: Role) =>
    api.patch<Member>(`/orgs/${enc(slug)}/members/${userId}`, { role }),
  removeMember: (slug: string, userId: string) =>
    api.delete(`/orgs/${enc(slug)}/members/${userId}`),

  listIssues: (slug: string, filters: IssueFilters, cursor: string | null) =>
    api.get<Page<IssueSummary>>(`/orgs/${enc(slug)}/issues${issueQuery(filters, cursor)}`),
  createIssue: (
    slug: string,
    projectKey: string,
    body: { title: string; status?: IssueStatus; priority?: number },
  ) => api.post<IssueDetail>(`/orgs/${enc(slug)}/projects/${enc(projectKey)}/issues`, body),
  getIssue: (slug: string, projectKey: string, number: number) =>
    api.get<IssueDetail>(issuePath(slug, projectKey, number)),
  patchIssue: (
    slug: string,
    projectKey: string,
    number: number,
    body: IssuePatch & { version: number },
  ) => api.patch<IssueDetail>(issuePath(slug, projectKey, number), body),
  putLabels: (
    slug: string,
    projectKey: string,
    number: number,
    body: { version: number; labelIds: string[] },
  ) => api.put<IssueDetail>(`${issuePath(slug, projectKey, number)}/labels`, body),
  bulkStatus: (slug: string, body: { issueIds: string[]; status: IssueStatus }) =>
    api.post<{ items: IssueSummary[] }>(`/orgs/${enc(slug)}/issues/bulk-status`, body),
  deleteIssue: (slug: string, projectKey: string, number: number) =>
    api.delete(issuePath(slug, projectKey, number)),

  listComments: (slug: string, projectKey: string, number: number, cursor: string | null) =>
    api.get<Page<Comment>>(
      `${issuePath(slug, projectKey, number)}/comments${cursorQuery(cursor)}`,
    ),
  addComment: (slug: string, projectKey: string, number: number, body: string) =>
    api.post<Comment>(`${issuePath(slug, projectKey, number)}/comments`, { body }),
  editComment: (slug: string, projectKey: string, number: number, id: string, body: string) =>
    api.patch<Comment>(`${issuePath(slug, projectKey, number)}/comments/${id}`, { body }),
  deleteComment: (slug: string, projectKey: string, number: number, id: string) =>
    api.delete(`${issuePath(slug, projectKey, number)}/comments/${id}`),
};
