import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentOf, docFromLog } from '../../src/collab/docState.js';
import { createLogger } from '../../src/lib/logger.js';
import { autoVersionOnce } from '../../src/worker/autoVersions.js';
import { registerUser, type TestUser } from '../helpers/http.js';
import { freshDatabase, startInstance, stopInstances, type RunningInstance } from '../helpers/instance.js';
import { TestClient } from '../helpers/wsClient.js';

let server: RunningInstance;
let owner: TestUser;
let commenter: TestUser;
let docId: string;
let editor: TestClient;
let observer: TestClient;

async function storedText(): Promise<string> {
  return contentOf(docFromLog(await server.instance.store.load(docId))).toString();
}

async function versionKinds(): Promise<string[]> {
  const rows = await server.instance.db
    .selectFrom('doc_versions')
    .select('kind')
    .where('doc_id', '=', docId)
    .orderBy('created_at')
    .orderBy('seq')
    .orderBy('kind')
    .execute();
  return rows.map((row) => row.kind);
}

/** Replaces the editor's text and waits until the observer has it. */
async function setText(value: string) {
  editor.doc.transact(() => {
    editor.text.delete(0, editor.text.length);
    editor.text.insert(0, value);
  });
  await observer.waitForText(value);
}

async function named(label: string): Promise<string> {
  const response = await owner.api.post(`/api/docs/${docId}/versions`, { label });
  expect(response.status).toBe(201);
  return response.body.version.id;
}

async function restore(versionId: string) {
  const response = await owner.api.post(`/api/docs/${docId}/versions/${versionId}/restore`, {});
  expect(response.status).toBe(200);
  return response.body as { changed: boolean; seq: number | null; preRestoreVersionId: string | null };
}

beforeEach(async () => {
  await freshDatabase();
  server = await startInstance();
  owner = await registerUser(server.instance.app, 'Olive');
  commenter = await registerUser(server.instance.app, 'Cleo');
  await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/members`, {
    email: commenter.email,
  });
  const created = await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/docs`, {
    title: 'History',
    workspaceAccess: 'commenter',
  });
  docId = created.body.doc.id;
  editor = await TestClient.join(server.url, docId, { token: owner.token });
  observer = await TestClient.join(server.url, docId, { token: owner.token });
});

afterEach(async () => {
  await Promise.all([editor.close(), observer.close()]);
  await stopInstances();
});

describe('named versions', () => {
  it('stores the state at the current head and previews its text', async () => {
    await setText('first draft');
    const id = await named('Draft 1');
    const head = await server.instance.db
      .selectFrom('docs')
      .select('head_seq')
      .where('id', '=', docId)
      .executeTakeFirstOrThrow();
    const preview = await owner.api.get(`/api/versions/${id}`);
    expect(preview.body.version).toEqual(
      expect.objectContaining({ kind: 'named', label: 'Draft 1', seq: head.head_seq, text: 'first draft' }),
    );
    const list = await owner.api.get(`/api/docs/${docId}/versions`);
    expect(list.body.versions.map((v: { id: string }) => v.id)).toEqual([id]);
  });

  it('requires editor access', async () => {
    const id = await named('Private');
    expect((await commenter.api.get(`/api/docs/${docId}/versions`)).status).toBe(403);
    expect((await commenter.api.get(`/api/versions/${id}`)).status).toBe(403);
    expect((await commenter.api.post(`/api/docs/${docId}/versions`, { label: 'x' })).status).toBe(403);
  });

  it('requires a label', async () => {
    const response = await owner.api.post(`/api/docs/${docId}/versions`, { label: '' });
    expect(response.status).toBe(400);
  });
});

describe('restore', () => {
  it('writes nothing when the text already matches', async () => {
    await setText('unchanged');
    const id = await named('Same');
    const result = await restore(id);
    expect(result).toEqual({ changed: false, seq: null, preRestoreVersionId: null });
    expect(await versionKinds()).toEqual(['named']);
  });

  it('records one pre_restore version, and restoring it brings the text back', async () => {
    await setText('version one');
    const v1 = await named('One');
    await setText('version two, much longer');
    const result = await restore(v1);
    expect(result.changed).toBe(true);
    await observer.waitForText('version one');
    expect(await storedText()).toBe('version one');
    expect(await versionKinds()).toEqual(['named', 'pre_restore']);

    const back = await restore(result.preRestoreVersionId!);
    expect(back.changed).toBe(true);
    await observer.waitForText('version two, much longer');
    expect(await versionKinds()).toEqual(['named', 'pre_restore', 'pre_restore']);
  });

  it('keeps text another user typed elsewhere while the restore happened', async () => {
    await setText('alpha beta');
    const v1 = await named('Lower');
    editor.doc.transact(() => {
      editor.text.delete(0, 5);
      editor.text.insert(0, 'ALPHA');
    });
    await observer.waitForText('ALPHA beta');

    observer.autoSend = false;
    observer.append(' gamma');
    await restore(v1);
    await editor.waitForText('alpha beta');
    observer.flush();
    await editor.waitForText('alpha beta gamma');
    await observer.waitForText('alpha beta gamma');
    expect(await storedText()).toBe('alpha beta gamma');
  });

  it('restores a change larger than the WebSocket update limit', async () => {
    editor.append('a'.repeat(150_000));
    editor.append('b'.repeat(150_000));
    await observer.waitFor(() => observer.text.length === 300_000);
    const big = await named('Big');
    await setText('short');
    const result = await restore(big);
    expect(result.changed).toBe(true);
    await observer.waitFor(() => observer.text.length === 300_000);
    expect(await storedText()).toBe('a'.repeat(150_000) + 'b'.repeat(150_000));
    const largest = await server.instance.db
      .selectFrom('doc_updates')
      .select(sql<number>`max(octet_length("update"))`.as('bytes'))
      .where('doc_id', '=', docId)
      .executeTakeFirstOrThrow();
    expect(largest.bytes).toBeGreaterThan(262_144);
  });

  it('restores emoji at the edge of the changed range without broken characters', async () => {
    await setText('a😀b');
    const v1 = await named('Grinning');
    await setText('a😃b');
    await restore(v1);
    await observer.waitForText('a😀b');
    expect(await storedText()).toBe('a😀b');
  });

  it('is refused for commenters and for versions of other documents', async () => {
    const id = await named('Mine');
    const refused = await commenter.api.post(`/api/docs/${docId}/versions/${id}/restore`, {});
    expect(refused.status).toBe(403);
    const other = await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/docs`, {
      title: 'Other',
    });
    const mismatch = await owner.api.post(
      `/api/docs/${other.body.doc.id}/versions/${id}/restore`,
      {},
    );
    expect(mismatch.status).toBe(404);
  });
});

describe('automatic versions', () => {
  const options = () => ({ db: server.instance.db, logger: createLogger('silent'), minutes: 10 });

  it('waits until the newest version or the document is old enough', async () => {
    await setText('early');
    expect(await autoVersionOnce(options(), server.clock.now())).toBe(0);
    server.clock.advance(10 * 60_000);
    expect(await autoVersionOnce(options(), server.clock.now())).toBe(1);
  });

  it('creates one version when run twice with no new updates', async () => {
    await setText('steady');
    server.clock.advance(10 * 60_000);
    expect(await autoVersionOnce(options(), server.clock.now())).toBe(1);
    server.clock.advance(10 * 60_000);
    expect(await autoVersionOnce(options(), server.clock.now())).toBe(0);
    expect(await versionKinds()).toEqual(['auto']);
  });

  it('keeps only the newest 50 automatic versions and every named one', async () => {
    await named('Keep me');
    for (let i = 0; i < 52; i += 1) {
      editor.append(`${i};`);
      await observer.waitFor(() => observer.text.toString().endsWith(`${i};`));
      server.clock.advance(10 * 60_000);
      expect(await autoVersionOnce(options(), server.clock.now())).toBe(1);
    }
    const kinds = await versionKinds();
    expect(kinds.filter((kind) => kind === 'auto')).toHaveLength(50);
    expect(kinds.filter((kind) => kind === 'named')).toHaveLength(1);
    const oldest = await server.instance.db
      .selectFrom('doc_versions')
      .select('seq')
      .where('doc_id', '=', docId)
      .where('kind', '=', 'auto')
      .orderBy('seq')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(oldest.seq).toBe(3);
  });
});
