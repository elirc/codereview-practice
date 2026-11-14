import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, registerUser } from '../helpers/http.js';
import { createHttpTestApp, type HttpTestApp } from '../helpers/httpApp.js';

let t: HttpTestApp;

beforeEach(async () => {
  t = await createHttpTestApp();
});

afterEach(async () => {
  await t.close();
});

describe('registration and sessions', () => {
  it('creates a personal workspace owned by the new user', async () => {
    const alice = await registerUser(t.app, 'Alice');
    const me = await alice.api.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual({ id: alice.id, email: 'alice@example.com', name: 'Alice' });
    expect(me.body.workspaces).toEqual([
      expect.objectContaining({ name: "Alice's workspace", role: 'owner' }),
    ]);
  });

  it('stores emails in lower case and refuses duplicates', async () => {
    const api = new ApiClient(t.app);
    const first = await api.post('/api/auth/register', {
      email: 'Bob@Example.com',
      name: 'Bob',
      password: 'correct horse battery',
    });
    expect(first.status).toBe(201);
    expect(first.body.user.email).toBe('bob@example.com');
    const second = await api.post('/api/auth/register', {
      email: 'bob@example.com',
      name: 'Bob Again',
      password: 'correct horse battery',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('invalid_state');
  });

  it('sets an HttpOnly SameSite=Lax session cookie and stores only its hash', async () => {
    const api = new ApiClient(t.app);
    const response = await api.request('POST', '/api/auth/register', {
      email: 'carol@example.com',
      name: 'Carol',
      password: 'correct horse battery',
    });
    const header = String(response.headers['set-cookie']);
    expect(header).toContain('cd_session=');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    const token = response.cookies.find((cookie) => cookie.name === 'cd_session')!.value;
    const rows = await t.db.selectFrom('sessions').select('token_hash').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logs in with the right password only', async () => {
    await registerUser(t.app, 'Dana');
    const api = new ApiClient(t.app);
    const wrong = await api.post('/api/auth/login', {
      email: 'dana@example.com',
      password: 'not the password',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_credentials');
    const unknown = await api.post('/api/auth/login', {
      email: 'nobody@example.com',
      password: 'not the password',
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('invalid_credentials');
    const right = await api.post('/api/auth/login', {
      email: 'DANA@example.com',
      password: 'correct horse battery',
    });
    expect(right.status).toBe(200);
  });

  it('expires sessions after fourteen days', async () => {
    const erin = await registerUser(t.app, 'Erin');
    t.clock.advance(14 * 86_400_000 - 1);
    expect((await erin.api.get('/api/auth/me')).status).toBe(200);
    t.clock.advance(1);
    const expired = await erin.api.get('/api/auth/me');
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('unauthenticated');
  });

  it('logout deletes the session and announces it', async () => {
    const frank = await registerUser(t.app, 'Frank');
    const response = await frank.api.post('/api/auth/logout', {});
    expect(response.status).toBe(204);
    expect((await frank.api.get('/api/auth/me')).status).toBe(401);
    expect(t.notifier.controlEvents).toEqual([
      expect.objectContaining({ kind: 'session_ended' }),
    ]);
    expect(await t.db.selectFrom('sessions').selectAll().execute()).toHaveLength(0);
  });
});

describe('request checks', () => {
  it('refuses mutating requests from another origin', async () => {
    const gina = await registerUser(t.app, 'Gina');
    const response = await gina.api.request(
      'POST',
      '/api/workspaces',
      { name: 'Elsewhere' },
      { origin: 'https://evil.example' },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('refuses mutating requests that are not JSON', async () => {
    const gina = await registerUser(t.app, 'Gina');
    const response = await gina.api.request(
      'POST',
      '/api/workspaces',
      { name: 'Form post' },
      { 'content-type': 'text/plain' },
    );
    expect(response.status).toBe(403);
  });

  it('rejects unknown body fields', async () => {
    const api = new ApiClient(t.app);
    const response = await api.post('/api/auth/register', {
      email: 'hal@example.com',
      name: 'Hal',
      password: 'correct horse battery',
      admin: true,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it('echoes an inbound request id in the envelope', async () => {
    const api = new ApiClient(t.app);
    const response = await api.request('GET', '/api/auth/me', undefined, {
      'x-request-id': 'trace-123',
    });
    expect(response.status).toBe(401);
    expect(response.body.error.requestId).toBe('trace-123');
    expect(response.headers['x-request-id']).toBe('trace-123');
  });
});
