import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerUser, type TestUser } from '../helpers/http.js';
import { createHttpTestApp, type HttpTestApp } from '../helpers/httpApp.js';

let t: HttpTestApp;
let owner: TestUser;
let workspaceId: string;

async function epoch(): Promise<number> {
  const row = await t.db
    .selectFrom('workspaces')
    .select('perm_epoch')
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  return row.perm_epoch;
}

beforeEach(async () => {
  t = await createHttpTestApp();
  owner = await registerUser(t.app, 'Olive');
  const created = await owner.api.post('/api/workspaces', { name: 'Team' });
  expect(created.status).toBe(201);
  workspaceId = created.body.workspace.id;
});

afterEach(async () => {
  await t.close();
});

describe('workspace members', () => {
  it('adds an existing user by email and bumps the permission epoch', async () => {
    const mia = await registerUser(t.app, 'Mia');
    const before = await epoch();
    const added = await owner.api.post(`/api/workspaces/${workspaceId}/members`, {
      email: 'MIA@example.com',
    });
    expect(added.status).toBe(201);
    expect(added.body.member).toEqual(expect.objectContaining({ userId: mia.id, role: 'member' }));
    expect(await epoch()).toBe(before + 1);
    expect(t.notifier.controlEvents).toContainEqual({ kind: 'workspace_perm', workspaceId });

    const list = await mia.api.get(`/api/workspaces/${workspaceId}/members`);
    expect(list.body.members.map((m: { name: string }) => m.name)).toEqual(['Mia', 'Olive']);
  });

  it('reports unknown emails and existing members', async () => {
    const unknown = await owner.api.post(`/api/workspaces/${workspaceId}/members`, {
      email: 'ghost@example.com',
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('user_not_found');

    await registerUser(t.app, 'Mia');
    await owner.api.post(`/api/workspaces/${workspaceId}/members`, { email: 'mia@example.com' });
    const again = await owner.api.post(`/api/workspaces/${workspaceId}/members`, {
      email: 'mia@example.com',
    });
    expect(again.status).toBe(409);
  });

  it('lets only the owner appoint or demote admins', async () => {
    const ada = await registerUser(t.app, 'Ada');
    const max = await registerUser(t.app, 'Max');
    await owner.api.post(`/api/workspaces/${workspaceId}/members`, {
      email: ada.email,
      role: 'admin',
    });
    await owner.api.post(`/api/workspaces/${workspaceId}/members`, { email: max.email });

    const promote = await ada.api.patch(`/api/workspaces/${workspaceId}/members/${max.id}`, {
      role: 'admin',
    });
    expect(promote.status).toBe(403);

    const byOwner = await owner.api.patch(`/api/workspaces/${workspaceId}/members/${max.id}`, {
      role: 'admin',
    });
    expect(byOwner.status).toBe(204);
  });

  it('refuses to remove or demote the workspace owner', async () => {
    const ada = await registerUser(t.app, 'Ada');
    await owner.api.post(`/api/workspaces/${workspaceId}/members`, {
      email: ada.email,
      role: 'admin',
    });
    const demote = await ada.api.patch(`/api/workspaces/${workspaceId}/members/${owner.id}`, {
      role: 'member',
    });
    expect(demote.status).toBe(422);
    expect(demote.body.error.code).toBe('owner_required');
    const remove = await ada.api.delete(`/api/workspaces/${workspaceId}/members/${owner.id}`);
    expect(remove.status).toBe(422);
    expect(remove.body.error.code).toBe('owner_required');
  });

  it('hides workspaces from non-members and blocks plain members from managing', async () => {
    const outsider = await registerUser(t.app, 'Otto');
    const hidden = await outsider.api.get(`/api/workspaces/${workspaceId}/members`);
    expect(hidden.status).toBe(404);

    const max = await registerUser(t.app, 'Max');
    await owner.api.post(`/api/workspaces/${workspaceId}/members`, { email: max.email });
    const rename = await max.api.patch(`/api/workspaces/${workspaceId}`, { name: 'Mine' });
    expect(rename.status).toBe(403);
  });
});

describe('workspace transfer', () => {
  it('requires the target to be a member', async () => {
    const outsider = await registerUser(t.app, 'Otto');
    const response = await owner.api.post(`/api/workspaces/${workspaceId}/transfer`, {
      userId: outsider.id,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('not_a_member');
  });

  it('makes the target owner and the previous owner an admin', async () => {
    const ada = await registerUser(t.app, 'Ada');
    await owner.api.post(`/api/workspaces/${workspaceId}/members`, { email: ada.email });
    const before = await epoch();
    const response = await owner.api.post(`/api/workspaces/${workspaceId}/transfer`, {
      userId: ada.id,
    });
    expect(response.status).toBe(204);
    const members = await ada.api.get(`/api/workspaces/${workspaceId}/members`);
    const roles = Object.fromEntries(
      members.body.members.map((m: { name: string; role: string }) => [m.name, m.role]),
    );
    expect(roles).toEqual({ Ada: 'owner', Olive: 'admin' });
    expect(await epoch()).toBe(before + 1);

    const back = await owner.api.post(`/api/workspaces/${workspaceId}/transfer`, {
      userId: owner.id,
    });
    expect(back.status).toBe(403);
  });
});

describe('workspace settings', () => {
  it('renames without bumping the epoch and toggles external sharing with a bump', async () => {
    const before = await epoch();
    const renamed = await owner.api.patch(`/api/workspaces/${workspaceId}`, { name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.workspace.name).toBe('Renamed');
    expect(await epoch()).toBe(before);

    const toggled = await owner.api.patch(`/api/workspaces/${workspaceId}`, {
      allowExternalSharing: true,
    });
    expect(toggled.body.workspace.allowExternalSharing).toBe(true);
    expect(await epoch()).toBe(before + 1);
  });
});
