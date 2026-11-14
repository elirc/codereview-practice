import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { errorMessage, useAuth } from '../auth';

export function HomePage() {
  const { workspaces, refresh } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      await api('POST', '/workspaces', { name });
      setName('');
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  return (
    <section>
      <h1>Workspaces</h1>
      <ul>
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <Link to={`/w/${workspace.id}`}>{workspace.name}</Link> <small>({workspace.role})</small>
          </li>
        ))}
      </ul>
      <form className="inline" onSubmit={create}>
        {error && <p className="error">{error}</p>}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New workspace" required />
        <button type="submit">Create</button>
      </form>
    </section>
  );
}
