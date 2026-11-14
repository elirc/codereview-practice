import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import type { Comment, UserSummary } from '../api/types';
import { appendComment, replaceComment, type CommentListData } from './cache';

export function useComments(orgSlug: string, projectKey: string, number: number) {
  return useInfiniteQuery({
    queryKey: queryKeys.comments(orgSlug, projectKey, number),
    queryFn: ({ pageParam }) => endpoints.listComments(orgSlug, projectKey, number, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

let pendingCounter = 0;

/** Shows the new comment straight away, marked pending, until the server answers. */
export function useAddComment(
  orgSlug: string,
  projectKey: string,
  number: number,
  author: UserSummary,
) {
  const queryClient = useQueryClient();
  const commentsKey = queryKeys.comments(orgSlug, projectKey, number);

  return useMutation<Comment, Error, string, { tempId: string }>({
    mutationFn: (body) => endpoints.addComment(orgSlug, projectKey, number, body),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: commentsKey });
      pendingCounter += 1;
      const tempId = `pending-${pendingCounter}`;
      const optimistic: Comment = {
        id: tempId,
        body,
        author,
        createdAt: new Date().toISOString(),
        editedAt: null,
        pending: true,
      };
      queryClient.setQueryData<CommentListData>(commentsKey, (data) =>
        appendComment(data, optimistic),
      );
      return { tempId };
    },
    onSuccess: (comment, _body, context) => {
      queryClient.setQueryData<CommentListData>(commentsKey, (data) =>
        replaceComment(data, context.tempId, comment),
      );
    },
    onError: (_error, _body, context) => {
      if (!context) return;
      queryClient.setQueryData<CommentListData>(commentsKey, (data) =>
        replaceComment(data, context.tempId, null),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: commentsKey }),
  });
}

export function useCommentActions(orgSlug: string, projectKey: string, number: number) {
  const queryClient = useQueryClient();
  const commentsKey = queryKeys.comments(orgSlug, projectKey, number);
  const refresh = () => queryClient.invalidateQueries({ queryKey: commentsKey });
  const edit = useMutation({
    mutationFn: (input: { id: string; body: string }) =>
      endpoints.editComment(orgSlug, projectKey, number, input.id, input.body),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => endpoints.deleteComment(orgSlug, projectKey, number, id),
    onSettled: refresh,
  });
  return { edit, remove };
}
