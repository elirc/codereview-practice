import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import type { IssueDetail, IssuePatch } from '../api/types';
import {
  createTestQueryClient,
  deferred,
  listData,
  makeIssue,
  summaryOf,
  wrapperFor,
} from '../test/utils';
import { findInList, type IssueListData } from './cache';
import { useIssueMutation, type IssueEdit } from './useIssueMutation';

const SLUG = 'acme';

/** A field edit whose preview is the edit itself. */
function edit(fields: IssuePatch & Partial<IssueDetail>): IssueEdit {
  return { kind: 'patch', patch: fields, preview: fields };
}
const OTHER = makeIssue({
  id: '22222222-2222-4222-8222-222222222222',
  identifier: 'ENG-2',
  number: 2,
  title: 'Other issue',
});

function setup(issue: IssueDetail = makeIssue()) {
  const queryClient = createTestQueryClient();
  const detailKey = queryKeys.issue(SLUG, issue.projectKey, issue.number);
  const allKey = queryKeys.issueList(SLUG, {});
  const todoKey = queryKeys.issueList(SLUG, { status: ['backlog'] });
  queryClient.setQueryData(detailKey, issue);
  // The issue sits on the second page of one list and the first page of another.
  queryClient.setQueryData(allKey, listData([summaryOf(OTHER)], [summaryOf(issue)]));
  queryClient.setQueryData(todoKey, listData([summaryOf(issue)]));
  const onConflict = vi.fn();
  const { result } = renderHook(() => useIssueMutation(SLUG, issue, { onConflict }), {
    wrapper: wrapperFor(queryClient),
  });
  const read = () => ({
    detail: queryClient.getQueryData<IssueDetail>(detailKey),
    all: findInList(queryClient.getQueryData<IssueListData>(allKey), issue.id),
    todo: findInList(queryClient.getQueryData<IssueListData>(todoKey), issue.id),
    other: findInList(queryClient.getQueryData<IssueListData>(allKey), OTHER.id),
  });
  return { queryClient, result, read, onConflict, issue };
}

describe('useIssueMutation', () => {
  it('shows the edit at once and then adopts the server issue', async () => {
    const server = deferred<IssueDetail>();
    const patch = vi.spyOn(endpoints, 'patchIssue').mockReturnValue(server.promise);
    vi.spyOn(endpoints, 'getIssue').mockResolvedValue(makeIssue({ status: 'done', version: 2 }));
    const { result, read } = setup();

    act(() => {
      result.current.mutate(edit({ status: 'done' }));
    });
    await waitFor(() => expect(read().detail?.status).toBe('done'));
    expect(read().all?.status).toBe('done');
    expect(read().todo?.status).toBe('done');
    expect(read().detail?.version).toBe(1);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(SLUG, 'ENG', 1, { status: 'done', version: 1 });

    await act(async () => {
      server.resolve(makeIssue({ status: 'done', version: 2 }));
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(read().detail).toMatchObject({ status: 'done', version: 2 });
    expect(read().all).toMatchObject({ status: 'done', version: 2 });
    expect(read().todo).toMatchObject({ status: 'done', version: 2 });
    expect(read().other).toEqual(summaryOf(OTHER));
  });

  it('rolls back the detail and every list containing the issue on failure', async () => {
    vi.spyOn(endpoints, 'patchIssue').mockRejectedValue(
      new ApiError(500, 'internal_error', 'Something went wrong on our side.'),
    );
    const { result, read, onConflict, issue } = setup();

    act(() => {
      result.current.mutate(edit({ title: 'Renamed', priority: 4 }));
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(read().detail).toEqual(issue);
    expect(read().all).toEqual(summaryOf(issue));
    expect(read().todo).toEqual(summaryOf(issue));
    expect(onConflict).not.toHaveBeenCalled();
  });

  it('rolls back optimistic label changes too', async () => {
    vi.spyOn(endpoints, 'putLabels').mockRejectedValue(
      new ApiError(422, 'invalid_reference', 'labelIds does not refer to a valid record.'),
    );
    const { result, read, issue } = setup();
    const label = { id: 'l1', name: 'Bug', color: '#cc3333' };

    act(() => {
      result.current.mutate({ kind: 'labels', labelIds: ['l1'], preview: { labels: [label] } });
    });
    await waitFor(() => expect(read().detail?.labels).toEqual([label]));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(read().detail?.labels).toEqual(issue.labels);
    expect(read().all?.labels).toEqual(issue.labels);
  });

  it('replaces the cache with the server copy on a version conflict', async () => {
    const current = makeIssue({ status: 'in_progress', title: 'Edited elsewhere', version: 3 });
    vi.spyOn(endpoints, 'patchIssue').mockRejectedValue(
      new ApiError(409, 'version_conflict', 'This issue was changed by someone else.', {
        current,
      }),
    );
    const { result, read, onConflict } = setup();

    act(() => {
      result.current.mutate(edit({ status: 'done' }));
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(read().detail).toEqual(current);
    expect(read().all).toMatchObject({
      status: 'in_progress',
      title: 'Edited elsewhere',
      version: 3,
    });
    expect(read().todo).toMatchObject({ status: 'in_progress', version: 3 });
    expect(onConflict).toHaveBeenCalledWith(current);
  });

  it('sends quick successive edits one at a time with the version each one produced', async () => {
    const first = deferred<IssueDetail>();
    const second = deferred<IssueDetail>();
    const patch = vi
      .spyOn(endpoints, 'patchIssue')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, read } = setup();

    act(() => {
      result.current.mutate(edit({ status: 'todo' }));
      result.current.mutate(edit({ priority: 4 }));
    });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(read().detail?.status).toBe('todo'));
    expect(patch).toHaveBeenLastCalledWith(SLUG, 'ENG', 1, { status: 'todo', version: 1 });

    await act(async () => {
      first.resolve(makeIssue({ status: 'todo', version: 2 }));
    });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenLastCalledWith(SLUG, 'ENG', 1, { priority: 4, version: 2 });

    await act(async () => {
      second.resolve(makeIssue({ status: 'todo', priority: 4, version: 3 }));
    });
    await waitFor(() => expect(read().detail?.version).toBe(3));
    expect(read().detail).toMatchObject({ status: 'todo', priority: 4 });
  });
});
