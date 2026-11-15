import { useCallback, useEffect, useState, type FormEvent, type RefObject } from 'react';
import type * as Y from 'yjs';
import { api, ApiError, withLink, type Comment, type Thread } from '../api';
import { errorMessage } from '../auth';
import { selectionAnchor } from '../collab/anchors';
import { canComment, canEdit, type DocRole } from '../collab/roles';

interface Props {
  docId: string;
  link: string | null;
  role: DocRole | null;
  ydoc: Y.Doc;
  textarea: RefObject<HTMLTextAreaElement>;
  refreshKey: number;
  userId: string | null;
}

const RETRIES = 5;
const RETRY_MS = 400;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function CommentsPanel({ docId, link, role, ydoc, textarea, refreshKey, userId }: Props) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [body, setBody] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<{ threads: Thread[] }>('GET', withLink(`/docs/${docId}/threads`, link));
      setThreads(result.threads);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [docId, link]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  async function createThread(event: FormEvent) {
    event.preventDefault();
    const element = textarea.current;
    if (!element || element.selectionStart === element.selectionEnd) {
      setError('Select some text to comment on.');
      return;
    }
    const anchor = selectionAnchor(
      ydoc.getText('content'),
      element.selectionStart,
      element.selectionEnd,
    );
    await run(async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await api('POST', withLink(`/docs/${docId}/threads`, link), { anchor, body });
          setBody('');
          return;
        } catch (failure) {
          const retry = failure instanceof ApiError && failure.code === 'anchor_unknown';
          if (!retry || attempt >= RETRIES) throw failure;
          await wait(RETRY_MS);
        }
      }
    });
  }

  function select(thread: Thread) {
    const element = textarea.current;
    if (!element || thread.detached) return;
    element.focus();
    element.setSelectionRange(thread.range.start, thread.range.end);
  }

  function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const { id, body: edited } = editing;
    void run(async () => {
      await api('PATCH', `/comments/${id}`, { body: edited });
      setEditing(null);
    });
  }

  const commenting = userId !== null && canComment(role);
  const ownComment = (comment: Comment) =>
    commenting && comment.authorId === userId && !comment.deletedAt;

  return (
    <section className="panel">
      <h2>Comments</h2>
      {error && <p className="error">{error}</p>}
      {commenting && (
        <form onSubmit={createThread}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={4000} required />
          <button type="submit">Comment on selection</button>
        </form>
      )}
      {threads.map((thread) => (
        <article key={thread.id} className={`thread ${thread.status}`}>
          <blockquote onClick={() => select(thread)}>
            {thread.quotedText}
            {thread.detached && <em> (text removed)</em>}
          </blockquote>
          {thread.comments.map((comment) =>
            editing?.id === comment.id ? (
              <form key={comment.id} className="inline" onSubmit={saveEdit}>
                <input
                  value={editing.body}
                  onChange={(e) => setEditing({ id: comment.id, body: e.target.value })}
                  maxLength={4000}
                  required
                />
                <button type="submit">Save</button>
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <p key={comment.id}>
                <strong>{comment.authorName}</strong>:{' '}
                {comment.deletedAt ? <em>deleted</em> : comment.body}
                {comment.editedAt && !comment.deletedAt && <small> (edited)</small>}
                {ownComment(comment) && (
                  <>
                    <button onClick={() => setEditing({ id: comment.id, body: comment.body })}>
                      Edit
                    </button>
                    <button
                      onClick={() => void run(() => api('DELETE', `/comments/${comment.id}`))}
                    >
                      Delete
                    </button>
                  </>
                )}
              </p>
            ),
          )}
          {commenting && (
            <form
              className="inline"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await api('POST', `/threads/${thread.id}/comments`, { body: replies[thread.id] ?? '' });
                  setReplies({ ...replies, [thread.id]: '' });
                });
              }}
            >
              <input
                value={replies[thread.id] ?? ''}
                onChange={(e) => setReplies({ ...replies, [thread.id]: e.target.value })}
                placeholder="Reply"
                required
              />
              <button type="submit">Reply</button>
            </form>
          )}
          {commenting && (canEdit(role) || thread.createdBy === userId) && (
            <button
              onClick={() =>
                void run(() =>
                  api('POST', `/threads/${thread.id}/${thread.status === 'open' ? 'resolve' : 'reopen'}`),
                )
              }
            >
              {thread.status === 'open' ? 'Resolve' : 'Reopen'}
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
