import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import type { Role } from '../api/types';
import { useMe } from '../auth/session';

export function useProjects(slug: string) {
  return useQuery({
    queryKey: queryKeys.projects(slug),
    queryFn: async () => (await endpoints.listProjects(slug)).items,
  });
}

export function useLabels(slug: string) {
  return useQuery({
    queryKey: queryKeys.labels(slug),
    queryFn: async () => (await endpoints.listLabels(slug)).items,
  });
}

/** First page of members, used to fill assignee pickers. */
export function useMemberOptions(slug: string) {
  return useQuery({
    queryKey: [...queryKeys.members(slug), 'options'],
    queryFn: async () => (await endpoints.listMembers(slug, null, 100)).items,
  });
}

/** Members whose name or email contains `q`, for the assignee picker. */
export function useMemberSearch(slug: string, q: string) {
  return useQuery({
    queryKey: ['members', 'search', q],
    queryFn: async () => (await endpoints.searchMembers(slug, q)).items,
    enabled: q.length > 0,
    staleTime: 30_000,
  });
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** The caller's role in the org, for hiding controls; the server enforces the real rules. */
export function useRole(slug: string): Role | undefined {
  const me = useMe();
  return me.data?.memberships.find((m) => m.orgSlug === slug)?.role;
}

export function atLeast(role: Role | undefined, minimum: Role): boolean {
  return role !== undefined && RANK[role] >= RANK[minimum];
}
