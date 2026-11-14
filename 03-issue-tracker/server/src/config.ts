import { existsSync } from 'node:fs';

const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  databaseUrl: string;
  appOrigin: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Loads `.env` from the working directory when present; real environment variables win. */
export function loadDotEnvIfPresent(path = '.env'): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

/** Parses and validates configuration once; throws ConfigError listing every problem. */
export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const nodeEnv = oneOf(env, 'NODE_ENV', NODE_ENVS, 'development', problems);
  const logLevel = oneOf(env, 'LOG_LEVEL', LOG_LEVELS, 'info', problems);
  const host = env.HOST?.trim() || '127.0.0.1';

  const rawPort = env.PORT?.trim() || '3003';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('PORT must be an integer between 1 and 65535');
  }

  const databaseUrl = env.DATABASE_URL?.trim() ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL must be a postgres:// connection string');
  }

  const appOrigin = env.APP_ORIGIN?.trim() ?? '';
  if (!isOrigin(appOrigin)) {
    problems.push('APP_ORIGIN must be an origin such as https://tracker.example.com');
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return { nodeEnv, host, port, databaseUrl, appOrigin, logLevel };
}

function oneOf<T extends string>(
  env: Env,
  name: string,
  allowed: readonly T[],
  fallback: T,
  problems: string[],
): T {
  const value = env[name]?.trim() || fallback;
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  problems.push(`${name} must be one of ${allowed.join(', ')}`);
  return fallback;
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}
