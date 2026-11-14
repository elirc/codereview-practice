import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Doc, type Link, type Share, type WorkspaceAccess } from '../api';
import { errorMessage } from '../auth';

type ShareRole = Share['role'];
const ROLES: ShareRole[] = ['viewer', 'commenter', 'editor'];
const ACCESS: WorkspaceAccess[] = ['none', 'viewer', 'commenter', 'editor'];

export function SharePanel({ doc, onChange }: { doc: Doc; onChange: (doc: Doc) => void }) {
  const [shares, setShares] = useState<Share[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ShareRole>('viewer');
  const [linkRole, setLinkRole] = useState<ShareRole>('viewer');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [shareList, linkList] = await Promise.all([
      api<{ shares: Share[] }>('GET', `/docs/${doc.id}/shares`),
      api<{ links: Link[] }>('GET', `/docs/${doc.id}/links`),
    ]);
    setShares(shareList.shares);
    setLinks(linkList.links);
  }, [doc.id]);

  useEffect(() => {
    load().catch((failure: unknown) => setError(errorMessage(failure)));
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  function share(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await api('POST', `/docs/${doc.id}/shares`, { email, role });
      setEmail('');
    });
  }

  function createLink() {
    void run(async () => {
      const result = await api<{ token: string }>('POST', `/docs/${doc.id}/links`, { role: linkRole });
      setNewToken(result.token);
    });
  }

  return (
    <section className="panel">
      <h2>Sharing</h2>
      {error && <p className="error">{error}</p>}
      <label>
        Workspace members get{' '}
        <select
          value={doc.workspaceAccess}
          onChange={(e) =>
            void run(async () => {
              const result = await api<{ doc: Doc }>('PATCH', `/docs/${doc.id}`, {
                workspaceAccess: e.target.value,
              });
              onChange(result.doc);
            })
          }
        >
          {ACCESS.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <ul>
        {shares.map((entry) => (
          <li key={entry.userId}>
            {entry.name} ({entry.email}){entry.external && ' · external'}{' '}
            <select
              value={entry.role}
              onChange={(e) =>
                void run(() => api('PATCH', `/docs/${doc.id}/shares/${entry.userId}`, { role: e.target.value }))
              }
            >
              {ROLES.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <button onClick={() => void run(() => api('DELETE', `/docs/${doc.id}/shares/${entry.userId}`))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form className="inline" onSubmit={share}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" required />
        <select value={role} onChange={(e) => setRole(e.target.value as ShareRole)}>
          {ROLES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <button type="submit">Share</button>
      </form>

      <h3>Links</h3>
      {newToken && (
        <p className="notice">
          Copy this link now; it is not shown again:{' '}
          <code>{`${window.location.origin}/d/${doc.id}?link=${newToken}`}</code>
        </p>
      )}
      <ul>
        {links.map((entry) => (
          <li key={entry.id}>
            {entry.role} link{entry.expiresAt && `, expires ${new Date(entry.expiresAt).toLocaleString()}`}
            {entry.revokedAt ? (
              ' · revoked'
            ) : (
              <button onClick={() => void run(() => api('DELETE', `/docs/${doc.id}/links/${entry.id}`))}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      <span className="inline">
        <select value={linkRole} onChange={(e) => setLinkRole(e.target.value as ShareRole)}>
          {ROLES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <button onClick={createLink}>Create link</button>
      </span>
    </section>
  );
}
