import type { FastifyBaseLogger } from 'fastify';
import { pino } from 'pino';

export type Logger = FastifyBaseLogger;

const redact = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  'token',
  '*.password',
  '*.token',
];

/** Returns the URL with the value of every `link` query parameter replaced. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]link=)[^&#]*/g, '$1[redacted]');
}

interface LoggedRequest {
  method?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}

/** Serializes a request for logs: method, URL with link tokens redacted, and client address. */
export function serializeRequest(request: LoggedRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactUrl(request.url ?? ''),
    remoteAddress: request.ip ?? request.socket?.remoteAddress,
  };
}

/** Creates the process-wide JSON logger, optionally writing to the given destination. */
export function createLogger(
  level: string,
  bindings: Record<string, unknown> = {},
  destination?: pino.DestinationStream,
): Logger {
  const options = {
    level,
    redact,
    base: { pid: process.pid, ...bindings },
    serializers: { req: serializeRequest, err: pino.stdSerializers.err },
  };
  return destination ? pino(options, destination) : pino(options);
}
