import { useEffect, useState } from 'react';
import type { CollabProvider } from '../collab/provider';

interface Person {
  clientId: number;
  name: string;
  color: string;
}

function people(provider: CollabProvider): Person[] {
  const list: Person[] = [];
  provider.awareness.getStates().forEach((state, clientId) => {
    if (clientId === provider.doc.clientID) return;
    const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
    if (!user || typeof user.name !== 'string') return;
    list.push({ clientId, name: user.name, color: typeof user.color === 'string' ? user.color : '#666' });
  });
  return list;
}

export function PresenceList({ provider }: { provider: CollabProvider }) {
  const [list, setList] = useState<Person[]>(() => people(provider));
  useEffect(() => {
    setList(people(provider));
    const offPresence = provider.on('presence', () => setList(people(provider)));
    const offDoc = provider.on('doc', () => setList(people(provider)));
    return () => {
      offPresence();
      offDoc();
    };
  }, [provider]);

  if (list.length === 0) return <p className="presence">Nobody else is here.</p>;
  return (
    <p className="presence">
      Also here:{' '}
      {list.map((person) => (
        <span key={person.clientId} style={{ color: person.color }}>
          {person.name}{' '}
        </span>
      ))}
    </p>
  );
}
