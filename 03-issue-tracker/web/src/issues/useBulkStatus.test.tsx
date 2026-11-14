import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import {
  createTestQueryClient,
  deferred,
  listData,
  makeIssue,
  summaryOf,
  wrapperFor,
} from '../test/utils';
import { findInList, type IssueListData } from './cache';
import { useBulkStatus } from './useBulkStatus';

describe('useBulkStatus', () => {
  it('shows the new status at once and keeps it after the server confirms', async () => {
    const queryClient = createTestQueryClient();
    const first = makeIssue();
    const second = makeIssue({ id: '22222222-2222-4222-8222-222222222222', number: 2 });
    const key = queryKeys.issueList('acme', {});
    queryClient.setQueryData(key, listData([summaryOf(first), summaryOf(second)]));
    const response = deferred<{ items: ReturnType<typeof summaryOf>[] }>();
    const bulk = vi.spyOn(endpoints, 'bulkStatus').mockReturnValue(response.promise);
    vi.spyOn(endpoints, 'listIssues').mockResolvedValue({ items: [], nextCursor: null });

    const { result } = renderHook(() => useBulkStatus('acme', {}), {
      wrapper: wrapperFor(queryClient),
    });
    act(() => result.current.mutate({ issueIds: [first.id], status: 'done' }));

    const read = (id: string) => findInList(queryClient.getQueryData<IssueListData>(key), id);
    await waitFor(() => expect(read(first.id)?.status).toBe('done'));
    expect(read(second.id)?.status).toBe('backlog');
    expect(bulk).toHaveBeenCalledWith('acme', { issueIds: [first.id], status: 'done' });

    await act(async () => response.resolve({ items: [summaryOf({ ...first, status: 'done' })] }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(read(first.id)?.status).toBe('done');
  });
});
