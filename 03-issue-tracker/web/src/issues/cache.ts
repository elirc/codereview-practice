import type { InfiniteData } from '@tanstack/react-query';
import type { Comment, IssueDetail, IssueSummary, Page } from '../api/types';

export type IssueListData = InfiniteData<Page<IssueSummary>, string | null>;
export type CommentListData = InfiniteData<Page<Comment>, string | null>;

export function listContains(data: IssueListData | undefined, issueId: string): boolean {
  return !!data?.pages.some((page) => page.items.some((item) => item.id === issueId));
}

export function findInList(data: IssueListData | undefined, issueId: string) {
  for (const page of data?.pages ?? []) {
    const found = page.items.find((item) => item.id === issueId);
    if (found) return found;
  }
  return undefined;
}

export function mapListIssue(
  data: IssueListData,
  issueId: string,
  update: (issue: IssueSummary) => IssueSummary,
): IssueListData {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === issueId ? update(item) : item)),
    })),
  };
}

export function toSummary(issue: IssueDetail): IssueSummary {
  const { description: _description, reporter: _reporter, ...summary } = issue;
  return summary;
}

export function appendComment(
  data: CommentListData | undefined,
  comment: Comment,
): CommentListData {
  if (!data || data.pages.length === 0) {
    return { pages: [{ items: [comment], nextCursor: null }], pageParams: [null] };
  }
  const last = data.pages.length - 1;
  return {
    ...data,
    pages: data.pages.map((page, i) =>
      i === last ? { ...page, items: [...page.items, comment] } : page,
    ),
  };
}

export function replaceComment(
  data: CommentListData | undefined,
  id: string,
  replacement: Comment | null,
): CommentListData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.flatMap((item) => {
        if (item.id !== id) return [item];
        return replacement ? [replacement] : [];
      }),
    })),
  };
}
