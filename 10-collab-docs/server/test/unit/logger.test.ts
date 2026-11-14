import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerRequestLogging } from '../../src/http/requestLog.js';
import { createLogger, redactUrl, serializeRequest } from '../../src/lib/logger.js';

describe('request logging', () => {
  it('replaces link query values', () => {
    expect(redactUrl('/api/docs/1?link=abc123')).toBe('/api/docs/1?link=[redacted]');
    expect(redactUrl('/api/docs/1/threads?x=1&link=abc&y=2')).toBe(
      '/api/docs/1/threads?x=1&link=[redacted]&y=2',
    );
    expect(redactUrl('/api/docs/1?unlinked=keep')).toBe('/api/docs/1?unlinked=keep');
    expect(serializeRequest({ method: 'GET', url: '/d?link=t', ip: '1.2.3.4' })).toEqual({
      method: 'GET',
      url: '/d?link=[redacted]',
      remoteAddress: '1.2.3.4',
    });
  });

  it('never writes a link token to the request log', async () => {
    const lines: string[] = [];
    const logger = createLogger('info', {}, { write: (line: string) => void lines.push(line) });
    const app = Fastify({ loggerInstance: logger, disableRequestLogging: true });
    registerRequestLogging(app);
    app.get('/api/docs/:id', async () => ({ ok: true }));
    const response = await app.inject({ method: 'GET', url: '/api/docs/42?link=s3cret-token-value' });
    expect(response.statusCode).toBe(200);
    const output = lines.join('');
    expect(output).toContain('incoming request');
    expect(output).toContain('request completed');
    expect(output).toContain('link=[redacted]');
    expect(output).not.toContain('s3cret-token-value');
    await app.close();
  });
});
