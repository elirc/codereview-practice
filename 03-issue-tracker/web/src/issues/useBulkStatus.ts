import { useMutation, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import type { IssueFilters, IssueStatus, IssueSummary } from '../api/types';
import type { IssueListData } from './cache';

interface BulkStatusInput {
  issueIds: string[];
  status: IssueStatus;
}

/** Applies a status to the selected issues, showing the change in the list right away. */
export function useBulkStatus(orgSlug: string, filters: IssueFilters) {
  const queryClient = useQueryClient();
  const listsKey = queryKeys.issueLists(orgSlug);
  const listKey = queryKeys.issueList(orgSlug, filters);

  return useMutation<
    { items: IssueSummary[] },
    Error,
    BulkStatusInput,
    { previous: IssueListData | undefined }
  >({
    mutationFn: (input) => endpoints.bulkStatus(orgSlug, input),
    onMutate: async ({ issueIds, status }) => {
      await queryClient.cancelQueries({ queryKey: listsKey });
      const previous = queryClient.getQueryData<IssueListData>(listKey);
      const selected = new Set(issueIds);
      queryClient.setQueriesData<IssueListData>({ queryKey: listsKey }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  selected.has(item.id) ? { ...item, status } : item,
                ),
              })),
            }
          : data,
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(listKey, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['org', orgSlug, 'issues'] }),
  });
}
