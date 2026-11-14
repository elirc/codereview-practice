import type { IssueFilters } from './types';

/** Every org-scoped key starts with ['org', slug] so data never crosses organisations. */
export const queryKeys = {
  me: ['me'] as const,
  org: (slug: string) => ['org', slug] as const,
  projects: (slug: string) => ['org', slug, 'projects'] as const,
  labels: (slug: string) => ['org', slug, 'labels'] as const,
  members: (slug: string) => ['org', slug, 'members'] as const,
  issueLists: (slug: string) => ['org', slug, 'issues', 'list'] as const,
  issueList: (slug: string, filters: IssueFilters) =>
    ['org', slug, 'issues', 'list', filters] as const,
  issue: (slug: string, projectKey: string, number: number) =>
    ['org', slug, 'issues', 'detail', projectKey, number] as const,
  comments: (slug: string, projectKey: string, number: number) =>
    ['org', slug, 'issues', 'comments', projectKey, number] as const,
};

export const mutationKeys = {
  issue: (slug: string, issueId: string) => ['org', slug, 'issue-edit', issueId] as const,
};
