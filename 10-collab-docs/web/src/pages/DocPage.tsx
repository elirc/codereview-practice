import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type * as Y from 'yjs';
import { api, withLink, type Doc } from '../api';
import { errorMessage, useAuth } from '../auth';
import { CollabProvider, type ProviderStatus } from '../collab/provider';
import { canEdit, type DocRole } from '../collab/roles';
import { bindTextarea } from '../collab/textareaBinding';
import { CommentsPanel } from '../components/CommentsPanel';
import { PresenceList } from '../components/PresenceList';
import { SharePanel } from '../components/SharePanel';
import { VersionsPanel } from '../components/VersionsPanel';

const COLORS = ['#d33', '#36c', '#393', '#c60', '#939', '#077'];

function socketUrl(docId: string, link: string | null): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const query = link ? `?link=${encodeURIComponent(link)}` : '';
  return `${scheme}://${window.location.host}/ws/docs/${docId}${query}`;
}

export function DocPage() {
  const { docId = '' } = useParams();
  const [search] = useSearchParams();
  const link = search.get('link');
  const { user } = useAuth();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<CollabProvider | null>(null);
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [role, setRole] = useState<DocRole | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('connecting');
  const [commentsVersion, setCommentsVersion] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ doc: Doc }>('GET', withLink(`/docs/${docId}`, link)).then(
      (result) => setDoc(result.doc),
      (failure: unknown) => setError(errorMessage(failure)),
    );
  }, [docId, link]);

  useEffect(() => {
    const next = new CollabProvider({ url: socketUrl(docId, link) });
    const offs = [
      next.on('status', setStatus),
      next.on('role', setRole),
      next.on('doc', setYdoc),
      next.on('meta', (title) => setDoc((current) => (current ? { ...current, title } : current))),
      next.on('comments', () => setCommentsVersion((n) => n + 1)),
    ];
    setProvider(next);
    setYdoc(next.doc);
    next.connect();
    return () => {
      offs.forEach((off) => off());
      next.destroy();
    };
  }, [docId, link]);

  useEffect(() => {
    if (!provider || !user) return;
    const color = COLORS[user.id.charCodeAt(0) % COLORS.length];
    provider.setPresence({ user: { name: user.name, color } });
  }, [provider, user]);

  useEffect(() => {
    const element = textarea.current;
    if (!ydoc || !element) return;
    return bindTextarea(ydoc.getText('content'), element);
  }, [ydoc]);

  useEffect(() => {
    if (status === 'connected') setCommentsVersion((n) => n + 1);
  }, [status]);

  function reportCursor() {
    const element = textarea.current;
    if (!provider || !element || !user) return;
    provider.setPresence({ cursor: { anchor: element.selectionStart, head: element.selectionEnd } });
  }

  async function rename() {
    if (!doc) return;
    const title = window.prompt('New title', doc.title);
    if (!title) return;
    try {
      const result = await api<{ doc: Doc }>('PATCH', `/docs/${docId}`, { title });
      setDoc(result.doc);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  async function trash() {
    if (!window.confirm('Move this document to the trash?')) return;
    try {
      await api('POST', `/docs/${docId}/trash`);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  if (error && !doc) return <p className="error">{error}</p>;
  const editable = canEdit(role) && status !== 'stopped';

  return (
    <div className="doc-layout">
      <section className="editor">
        <h1>
          {doc?.title ?? '…'}{' '}
          {canEdit(role) && <button onClick={() => void rename()}>Rename</button>}
          {doc?.canManage && <button onClick={() => void trash()}>Trash</button>}
        </h1>
        <p className="status">
          {provider?.stopReason ?? `${status}${role ? ` as ${role}` : ''}`}
          {!canEdit(role) && role && ' (read-only)'}
        </p>
        {error && <p className="error">{error}</p>}
        <textarea
          ref={textarea}
          readOnly={!editable}
          onSelect={reportCursor}
          onKeyUp={reportCursor}
          rows={24}
        />
        {provider && <PresenceList provider={provider} />}
      </section>
      <aside>
        {provider && ydoc && (
          <CommentsPanel
            docId={docId}
            link={link}
            role={role}
            ydoc={ydoc}
            textarea={textarea}
            refreshKey={commentsVersion}
            userId={user?.id ?? null}
          />
        )}
        {doc?.canManage && user && <SharePanel doc={doc} onChange={setDoc} />}
        {canEdit(role) && user && <VersionsPanel docId={docId} />}
      </aside>
    </div>
  );
}
