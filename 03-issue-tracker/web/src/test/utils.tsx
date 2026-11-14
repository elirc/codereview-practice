import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { IssueDetail, IssueSummary, Page } from '../api/types';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

export function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

export function makeIssue(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    identifier: 'ENG-1',
    projectKey: 'ENG',
    number: 1,
    title: 'Login button misaligned',
    description: 'Overlaps the footer.',
    status: 'backlog',
    priority: 2,
    assignee: null,
    reporter: { id: 'u-reporter', name: 'Reporter' },
    labels: [],
    version: 1,
    createdAt: '2026-03-02T09:00:00.000Z',
    updatedAt: '2026-03-02T09:00:00.000Z',
    ...overrides,
  };
}

export function summaryOf(issue: IssueDetail): IssueSummary {
  const { description: _description, reporter: _reporter, ...summary } = issue;
  return summary;
}

/** Cache shape of an infinite issue list with the given pages. */
export function listData(...pages: IssueSummary[][]) {
  return {
    pages: pages.map((items, i): Page<IssueSummary> => ({
      items,
      nextCursor: i < pages.length - 1 ? `cursor-${i}` : null,
    })),
    pageParams: pages.map((_, i) => (i === 0 ? null : `cursor-${i - 1}`)),
  };
}

/** A promise whose settlement the test controls. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
