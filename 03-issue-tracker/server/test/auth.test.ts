import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/plugins/auth.js';
import { call, createUser, errorCode, TEST_PASSWORD, useTestContext } from './support/context.js';

const DAY = 24 * 60 * 60 * 1000;

describe('auth', () => {
  const ctx = useTestContext();

  function sessionCookieFrom(res: { cookies: { name: string; value: string }[] }): string {
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (!cookie) throw new Error('no session cookie set');
    return `${cookie.name}=${cookie.value}`;
  }

  it('registers a user and starts a session', async () => {
    const res = await call(ctx, 'POST', '/api/auth/register', {
      body: { email: 'New.User@Example.com', name: 'New User', password: 'long enough password' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      user: { id: expect.any(String), email: 'new.user@example.com', name: 'New User' },
      memberships: [],
    });

    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.secure).toBeFalsy();

    const me = await call(ctx, 'GET', '/api/auth/me', { cookie: sessionCookieFrom(res) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('new.user@example.com');
  });

  it('rejects a second account for the same email regardless of case', async () => {
    await createUser(ctx, 'taken@example.com');
    const res = await call(ctx, 'POST', '/api/auth/register', {
      body: { email: 'TAKEN@example.com', name: 'Dup', password: 'long enough password' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('email_taken');
  });

  it('logs in with the right password and returns memberships', async () => {
    await createUser(ctx, 'login@example.com');
    const res = await call(ctx, 'POST', '/api/auth/login', {
      body: { email: 'Login@example.com', password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().memberships).toEqual([]);
    expect(Object.keys(res.json().user).sort()).toEqual(['email', 'id', 'name']);
    sessionCookieFrom(res);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    await createUser(ctx, 'login@example.com');
    const wrong = await call(ctx, 'POST', '/api/auth/login', {
      body: { email: 'login@example.com', password: 'not the password' },
    });
    const unknown = await call(ctx, 'POST', '/api/auth/login', {
      body: { email: 'nobody@example.com', password: 'not the password' },
    });
    for (const res of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(errorCode(res)).toBe('invalid_credentials');
    }
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });

  it('requires a session for /auth/me', async () => {
    const res = await call(ctx, 'GET', '/api/auth/me');
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('unauthenticated');
  });

  it('treats an expired session as signed out and clears the cookie', async () => {
    const user = await createUser(ctx, 'expiring@example.com');
    ctx.clock.advance(15 * DAY);
    const res = await call(ctx, 'GET', '/api/auth/me', { cookie: user.cookie });
    expect(res.statusCode).toBe(401);
    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cleared?.value).toBe('');
    expect(cleared?.expires?.getTime()).toBeLessThan(Date.now());
  });

  it('logs out by deleting the session', async () => {
    const user = await createUser(ctx, 'bye@example.com');
    const res = await call(ctx, 'POST', '/api/auth/logout', { cookie: user.cookie });
    expect(res.statusCode).toBe(204);
    const me = await call(ctx, 'GET', '/api/auth/me', { cookie: user.cookie });
    expect(me.statusCode).toBe(401);
  });

  it('rejects unknown body properties', async () => {
    const res = await call(ctx, 'POST', '/api/auth/register', {
      body: { email: 'x@example.com', name: 'X', password: 'long enough password', role: 'owner' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'validation_failed',
      details: { fields: [{ path: 'body.role' }] },
    });
  });

  it('rejects a login posted from another origin', async () => {
    await createUser(ctx, 'login@example.com');
    const res = await call(ctx, 'POST', '/api/auth/login', {
      body: { email: 'login@example.com', password: TEST_PASSWORD },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('csrf_rejected');
  });
});
