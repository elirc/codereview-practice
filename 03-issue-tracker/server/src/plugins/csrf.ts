import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  const [mediaType] = header.split(';');
  return mediaType.trim().toLowerCase() === 'application/json';
}

/**
 * Mutating requests must be JSON and come from the app's own origin. A cross-site form
 * cannot send application/json without a CORS preflight, and browsers always attach Origin.
 */
export function registerCsrfProtection(app: FastifyInstance, appOrigin: string): void {
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (!isJsonContentType(request.headers['content-type']) || request.headers.origin !== appOrigin) {
      throw new AppError(
        403,
        'csrf_rejected',
        'The request was rejected because it did not come from the application.',
      );
    }
  });
}
