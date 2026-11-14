import { z } from 'zod';

const int = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);

const flag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

const origin = z
  .string()
  .url()
  .refine((value) => new URL(value).origin === value, {
    message: 'must be a bare origin such as http://localhost:5180',
  });

const logLevel = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

const databaseSchema = z.object({
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: logLevel,
});

const configSchema = databaseSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: int(8100).pipe(z.number().max(65535)),
  REDIS_URL: z.string().url(),
  APP_ORIGIN: origin,
  INSTANCE_ID: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  LOOPS_ENABLED: flag(true),

  MAX_CONNECTIONS_PER_USER_PER_DOC: int(8, 1),
  MAX_ANONYMOUS_CONNECTIONS_PER_DOC: int(50, 1),
  WS_RATE_PER_SEC: int(50, 1),
  WS_RATE_BURST: int(100, 1),
  MAX_UPDATE_BYTES: int(262_144, 1),
  MAX_DOC_BYTES: int(5_242_880, 1),

  ROOM_IDLE_MS: int(30_000),
  CATCHUP_INTERVAL_MS: int(10_000, 100),
  PERM_SWEEP_MS: int(15_000, 100),
  PING_INTERVAL_MS: int(30_000, 100),

  COMPACT_MIN_UPDATES: int(200, 1),
  COMPACT_MIN_BYTES: int(1_048_576, 1),
  AUTO_VERSION_MINUTES: int(10),
  TRASH_RETENTION_DAYS: int(30),
});

export type Config = z.infer<typeof configSchema>;
export type DatabaseConfig = z.infer<typeof databaseSchema>;

export class ConfigError extends Error {}

function parse<T extends z.ZodTypeAny>(schema: T, env: Record<string, string | undefined>): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  return result.data;
}

/** Reads and validates the full server and worker configuration. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return parse(configSchema, env);
}

/** Reads and validates the subset needed by the migrate and seed commands. */
export function loadDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  return parse(databaseSchema, env);
}
