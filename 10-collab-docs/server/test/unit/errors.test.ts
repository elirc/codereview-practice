import Fastify from 'fastify';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { errors, registerErrorHandling } from '../../src/http/errors.js';
import { validate } from '../../src/http/validate.js';

function appWithRoutes() {
  const app = Fastify({ logger: false, genReqId: () => 'req-1' });
  registerErrorHandling(app);
  app.get('/app-error', async () => {
    throw errors.forbidden();
  });
  app.get('/boom', async () => {
    throw new Error('database password is hunter2');
  });
  app.post('/validated', async (request) =>
    validate(z.object({ title: z.string().min(1) }).strict(), request.body),
  );
  return app;
}

describe('error envelope', () => {
  it('renders domain errors with their status and code', async () => {
    const response = await appWithRoutes().inject({ method: 'GET', url: '/app-error' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'You are not allowed to do that.',
        details: {},
        requestId: 'req-1',
      },
    });
  });

  it('hides unexpected errors behind internal_error', async () => {
    const response = await appWithRoutes().inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('internal_error');
    expect(response.body).not.toContain('hunter2');
  });

  it('lists failing fields for validation errors', async () => {
    const response = await appWithRoutes().inject({
      method: 'POST',
      url: '/validated',
      payload: { title: '', extra: true },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('validation_failed');
    const paths = body.error.details.fields.map((field: { path: string }) => field.path);
    expect(paths).toContain('title');
  });

  it('maps malformed JSON to validation_failed', async () => {
    const response = await appWithRoutes().inject({
      method: 'POST',
      url: '/validated',
      headers: { 'content-type': 'application/json' },
      payload: '{"title":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_failed');
  });

  it('uses the envelope for unknown routes', async () => {
    const response = await appWithRoutes().inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });
});
