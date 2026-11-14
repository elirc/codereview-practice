import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Version } from '../api';
import { errorMessage } from '../auth';

const KIND_LABEL: Record<Version['kind'], string> = {
  auto: 'Automatic',
  named: 'Named',
  pre_restore: 'Before restore',
};

export function VersionsPanel({ docId }: { docId: string }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api<{ versions: Version[] }>('GET', `/docs/${docId}/versions`);
    setVersions(result.versions);
  }, [docId]);

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

  function save(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await api('POST', `/docs/${docId}/versions`, { label });
      setLabel('');
    });
  }

  function show(version: Version) {
    void run(async () => {
      const result = await api<{ version: { text: string } }>('GET', `/versions/${version.id}`);
      setPreview({ id: version.id, text: result.version.text });
    });
  }

  function restore(version: Version) {
    if (!window.confirm('Restore this version? Your current text is kept as a version too.')) return;
    void run(async () => {
      await api('POST', `/docs/${docId}/versions/${version.id}/restore`);
      setPreview(null);
    });
  }

  return (
    <section className="panel">
      <h2>Versions</h2>
      {error && <p className="error">{error}</p>}
      <form className="inline" onSubmit={save}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Version name" maxLength={100} required />
        <button type="submit">Save version</button>
      </form>
      <ul>
        {versions.map((version) => (
          <li key={version.id}>
            {version.label ?? KIND_LABEL[version.kind]} · {new Date(version.createdAt).toLocaleString()}{' '}
            <button onClick={() => show(version)}>Preview</button>
            <button onClick={() => restore(version)}>Restore</button>
          </li>
        ))}
      </ul>
      {preview && <pre className="preview">{preview.text}</pre>}
    </section>
  );
}
