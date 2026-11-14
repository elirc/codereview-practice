import { pino, type Logger } from 'pino';
import type { LogLevel } from '../config.js';

/** Logger for scripts that run outside the HTTP server. */
export function createScriptLogger(name: string, level: LogLevel): Logger {
  return pino({ name, level });
}
