import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import { createTestQueryClient, wrapperFor } from '../test/utils';
import { useLogout } from './session';

describe('query keys', () => {
  it('scope every org resource by org slug', () => {
    const keys = [
      queryKeys.org('acme'),
      queryKeys.projects('acme'),
      queryKeys.labels('acme'),
      queryKeys.members('acme'),
      queryKeys.issueLists('acme'),
      queryKeys.issueList('acme', { status: ['todo'] }),
      queryKeys.issue('acme', 'ENG', 1),
      queryKeys.comments('acme', 'ENG', 1),
    ];
    for (const key of keys) {
      expect(key.slice(0, 2)).toEqual(['org', 'acme']);
    }
  });

  it('never share a key between two orgs with the same project key and number', () => {
    expect(queryKeys.issue('acme', 'ENG', 1)).not.toEqual(queryKeys.issue('globex', 'ENG', 1));
    expect(queryKeys.issueList('acme', {})).not.toEqual(queryKeys.issueList('globex', {}));
  });
});

describe('logout', () => {
  it('clears every cached query', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.projects('acme'), [{ id: 'p1' }]);
    queryClient.setQueryData(queryKeys.issue('acme', 'ENG', 1), { id: 'i1' });
    queryClient.setQueryData(queryKeys.labels('globex'), []);
    vi.spyOn(endpoints, 'logout').mockResolvedValue(undefined);

    const { result } = renderHook(() => useLogout(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryCache().findAll({ queryKey: ['org'] })).toHaveLength(0);
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull();
  });

  it('clears the cache even when the server call fails', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.projects('acme'), [{ id: 'p1' }]);
    vi.spyOn(endpoints, 'logout').mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useLogout(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(queryClient.getQueryCache().findAll({ queryKey: ['org'] })).toHaveLength(0);
  });
});
