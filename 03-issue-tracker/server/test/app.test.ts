import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { createDb, type Database } from '../src/db/index.js';
import { systemClock } from '../src/lib/clock.js';
import { APP_ORIGIN, testConfig } from './support/config.js';

describe('application shell', () => {
  let app: App;
  let db: Database;

  beforeAll(async () => {
    const config = testConfig();
    db = createDb(config.databaseUrl);
    app = await buildApp({ config, clock: systemClock, db });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('answers health checks', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('uses the error envelope for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nothing-here' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('not_found');
    expect(typeof body.error.requestId).toBe('string');
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
  });

  it('propagates an inbound request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/nothing-here',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(res.headers['x-request-id']).toBe('req-123');
    expect(res.json().error.requestId).toBe('req-123');
  });

  it('rejects mutating requests without the application origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/health',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_rejected');
  });

  it('rejects mutating requests that are not JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/health',
      headers: { origin: APP_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_rejected');
  });
});
