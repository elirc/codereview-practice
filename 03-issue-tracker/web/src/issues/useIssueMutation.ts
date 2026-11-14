import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { endpoints } from '../api/endpoints';
import { mutationKeys, queryKeys } from '../api/keys';
import type { IssueDetail, IssuePatch, IssueSummary } from '../api/types';
import { findInList, listContains, mapListIssue, toSummary, type IssueListData } from './cache';

export interface IssueRef {
  id: string;
  projectKey: string;
  number: number;
}

/** An edit plus the fields to show while it is in flight. */
export type IssueEdit =
  | { kind: 'patch'; patch: IssuePatch; preview: Partial<IssueDetail> }
  | { kind: 'labels'; labelIds: string[]; preview: Pick<IssueSummary, 'labels'> };

interface Snapshot {
  detail: IssueDetail | undefined;
  lists: [QueryKey, IssueListData | undefined][];
}

/**
 * Optimistic edits to one issue. Edits share a mutation scope per issue, so they reach the
 * server one at a time and each sends the version the previous one produced.
 */
export function useIssueMutation(
  orgSlug: string,
  issue: IssueRef,
  options: { onConflict?: (current: IssueDetail) => void } = {},
) {
  const queryClient = useQueryClient();
  const detailKey = queryKeys.issue(orgSlug, issue.projectKey, issue.number);
  const listsKey = queryKeys.issueLists(orgSlug);
  const mutationKey = mutationKeys.issue(orgSlug, issue.id);

  // Previews never touch `version`, so this is the last version the server confirmed.
  const cachedVersion = (): number => {
    const detail = queryClient.getQueryData<IssueDetail>(detailKey);
    if (detail) return detail.version;
    for (const [, data] of queryClient.getQueriesData<IssueListData>({ queryKey: listsKey })) {
      const found = findInList(data, issue.id);
      if (found) return found.version;
    }
    throw new Error('The issue is not loaded.');
  };

  const adoptServerIssue = (server: IssueDetail) => {
    const serverKey = queryKeys.issue(orgSlug, server.projectKey, server.number);
    queryClient.setQueryData(serverKey, server);
    if (server.projectKey !== issue.projectKey || server.number !== issue.number) {
      queryClient.removeQueries({ queryKey: detailKey, exact: true });
    }
    queryClient.setQueriesData<IssueListData>({ queryKey: listsKey }, (data) =>
      data && listContains(data, issue.id)
        ? mapListIssue(data, issue.id, (item) => ({ ...item, ...toSummary(server) }))
        : data,
    );
  };

  return useMutation<IssueDetail, Error, IssueEdit, Snapshot>({
    mutationKey,
    scope: { id: mutationKey.join(':') },
    mutationFn: (edit) => {
      const version = cachedVersion();
      return edit.kind === 'labels'
        ? endpoints.putLabels(orgSlug, issue.projectKey, issue.number, {
            version,
            labelIds: edit.labelIds,
          })
        : endpoints.patchIssue(orgSlug, issue.projectKey, issue.number, {
            ...edit.patch,
            version,
          });
    },
    onMutate: async (edit) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: listsKey }),
      ]);
      const detail = queryClient.getQueryData<IssueDetail>(detailKey);
      const lists = queryClient
        .getQueriesData<IssueListData>({ queryKey: listsKey })
        .filter(([, data]) => listContains(data, issue.id));

      if (detail) {
        queryClient.setQueryData<IssueDetail>(detailKey, { ...detail, ...edit.preview });
      }
      for (const [key, data] of lists) {
        if (data) {
          queryClient.setQueryData(
            key,
            mapListIssue(data, issue.id, (item) => ({ ...item, ...edit.preview })),
          );
        }
      }
      return { detail, lists };
    },
    onError: (error, _edit, snapshot) => {
      if (snapshot) {
        if (snapshot.detail) queryClient.setQueryData(detailKey, snapshot.detail);
        for (const [key, data] of snapshot.lists) queryClient.setQueryData(key, data);
      }
      const current = error instanceof ApiError ? error.details?.current : undefined;
      if (error instanceof ApiError && error.code === 'version_conflict' && current) {
        adoptServerIssue(current as IssueDetail);
        options.onConflict?.(current as IssueDetail);
      }
    },
    onSuccess: (server) => adoptServerIssue(server),
    onSettled: async () => {
      // Refetching while a queued edit is pending would overwrite its preview.
      if (queryClient.isMutating({ mutationKey }) > 1) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey }),
        queryClient.invalidateQueries({ queryKey: listsKey }),
      ]);
    },
  });
}
