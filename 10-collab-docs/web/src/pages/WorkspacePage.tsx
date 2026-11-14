import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Doc, type Member, type Workspace } from '../api';
import { errorMessage, useAuth } from '../auth';

export function WorkspacePage() {
  const { workspaceId = '' } = useParams();
  const { workspaces, refresh } = useAuth();
  const workspace: Workspace | undefined = workspaces.find((w) => w.id === workspaceId);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [trashed, setTrashed] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [title, setTitle] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const manager = workspace?.role === 'owner' || workspace?.role === 'admin';

  const load = useCallback(async () => {
    try {
      const [docList, memberList] = await Promise.all([
        api<{ docs: Doc[] }>('GET', `/workspaces/${workspaceId}/docs?trashed=${trashed}`),
        api<{ members: Member[] }>('GET', `/workspaces/${workspaceId}/members`),
      ]);
      setDocs(docList.docs);
      setMembers(memberList.members);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [workspaceId, trashed]);

  useEffect(() => {
    void load();
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

  function createDoc(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await api('POST', `/workspaces/${workspaceId}/docs`, { title });
      setTitle('');
    });
  }

  function addMember(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await api('POST', `/workspaces/${workspaceId}/members`, { email: memberEmail });
      setMemberEmail('');
    });
  }

  return (
    <section>
      <h1>{workspace?.name ?? 'Workspace'}</h1>
      {error && <p className="error">{error}</p>}

      <h2>{trashed ? 'Trash' : 'Documents'}</h2>
      <label className="inline">
        <input type="checkbox" checked={trashed} onChange={(e) => setTrashed(e.target.checked)} /> Show
        trash
      </label>
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Your role</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {docs.map((doc) => (
            <tr key={doc.id}>
              <td>{trashed ? doc.title : <Link to={`/d/${doc.id}`}>{doc.title}</Link>}</td>
              <td>{doc.role}</td>
              <td>{new Date(doc.updatedAt).toLocaleString()}</td>
              <td>
                {trashed && doc.canManage && (
                  <button onClick={() => void run(() => api('POST', `/docs/${doc.id}/restore`))}>
                    Restore
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!trashed && (
        <form className="inline" onSubmit={createDoc}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New document" required />
          <button type="submit">Create</button>
        </form>
      )}

      <h2>Members</h2>
      <table>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <td>{member.name}</td>
              <td>{member.email}</td>
              <td>{member.role}</td>
              <td>
                {manager && member.role !== 'owner' && (
                  <button
                    onClick={() =>
                      void run(() => api('DELETE', `/workspaces/${workspaceId}/members/${member.userId}`))
                    }
                  >
                    Remove
                  </button>
                )}
                {workspace?.role === 'owner' && member.role !== 'owner' && (
                  <button
                    onClick={() =>
                      void run(() =>
                        api('PATCH', `/workspaces/${workspaceId}/members/${member.userId}`, {
                          role: member.role === 'admin' ? 'member' : 'admin',
                        }),
                      )
                    }
                  >
                    {member.role === 'admin' ? 'Make member' : 'Make admin'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {manager && (
        <>
          <form className="inline" onSubmit={addMember}>
            <input
              type="email"
              value={memberEmail}
              onChange={(e) => setMemberEmail(e.target.value)}
              placeholder="Add member by email"
              required
            />
            <button type="submit">Add</button>
          </form>
          <label className="inline">
            <input
              type="checkbox"
              checked={workspace?.allowExternalSharing ?? false}
              onChange={(e) =>
                void run(async () => {
                  await api('PATCH', `/workspaces/${workspaceId}`, {
                    allowExternalSharing: e.target.checked,
                  });
                  await refresh();
                })
              }
            />{' '}
            Allow sharing with people outside the workspace
          </label>
        </>
      )}
    </section>
  );
}
