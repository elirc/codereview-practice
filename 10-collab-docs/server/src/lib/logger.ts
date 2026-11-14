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

/** Creates the process-wide JSON logger. */
export function createLogger(level: string, bindings: Record<string, unknown> = {}): Logger {
  return pino({ level, redact, base: { pid: process.pid, ...bindings } });
}
