import { useState, type FormEvent } from 'react';
import type { Comment, UserSummary } from '../api/types';
import { useAddComment, useCommentActions, useComments } from './useComments';

interface Props {
  orgSlug: string;
  projectKey: string;
  number: number;
  me: UserSummary;
  canComment: boolean;
  canDeleteAny: boolean;
}

export function CommentsSection(props: Props) {
  const { orgSlug, projectKey, number, me, canComment, canDeleteAny } = props;
  const comments = useComments(orgSlug, projectKey, number);
  const add = useAddComment(orgSlug, projectKey, number, me);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = draft;
    if (!body.trim()) return;
    setDraft('');
    setError(null);
    add.mutate(body, {
      onError: (err) => {
        setDraft(body);
        setError(err.message);
      },
    });
  };

  const items = comments.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <h2>Comments</h2>
      {comments.error && <p className="error">{comments.error.message}</p>}
      <ul className="comments">
        {items.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            orgSlug={orgSlug}
            projectKey={projectKey}
            number={number}
            canEdit={canComment && comment.author.id === me.id}
            canDelete={(canComment && comment.author.id === me.id) || canDeleteAny}
          />
        ))}
      </ul>
      {comments.hasNextPage && (
        <button type="button" onClick={() => comments.fetchNextPage()}>
          Older comments
        </button>
      )}
      {canComment && (
        <form onSubmit={submit}>
          <label>
            Add a comment
            <textarea
              value={draft}
              maxLength={10_000}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit">Comment</button>
        </form>
      )}
    </section>
  );
}

interface ItemProps {
  comment: Comment;
  orgSlug: string;
  projectKey: string;
  number: number;
  canEdit: boolean;
  canDelete: boolean;
}

function CommentItem({ comment, orgSlug, projectKey, number, canEdit, canDelete }: ItemProps) {
  const { edit, remove } = useCommentActions(orgSlug, projectKey, number);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <li className={comment.pending ? 'pending' : undefined} data-testid="comment">
      <strong>{comment.author.name}</strong>{' '}
      <small>
        {new Date(comment.createdAt).toLocaleString()}
        {comment.editedAt && ' (edited)'}
        {comment.pending && ' · sending…'}
      </small>
      {editing === null ? (
        <p>{comment.body}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            edit.mutate({ id: comment.id, body: editing }, { onSuccess: () => setEditing(null) });
          }}
        >
          <textarea value={editing} onChange={(e) => setEditing(e.target.value)} />
          <button type="submit">Save</button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </form>
      )}
      {!comment.pending && (
        <span>
          {canEdit && editing === null && (
            <button type="button" onClick={() => setEditing(comment.body)}>
              Edit
            </button>
          )}
          {canDelete && (
            <button type="button" onClick={() => remove.mutate(comment.id)}>
              Delete
            </button>
          )}
        </span>
      )}
      {(edit.error ?? remove.error) && (
        <p className="error">{(edit.error ?? remove.error)?.message}</p>
      )}
    </li>
  );
}
