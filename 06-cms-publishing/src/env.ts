import { z } from "zod";

const logLevel = z
  .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
  .default("info");

const cronSecret = z.string().min(32, "must be at least 32 characters");

const appEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  CRON_SECRET: cronSecret,
  STORAGE_DRIVER: z.enum(["s3", "memory"]).default("s3"),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  LOG_LEVEL: logLevel,
});

const schedulerEnvSchema = z.object({
  APP_URL: z.string().url(),
  CRON_SECRET: cronSecret,
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
  LOG_LEVEL: logLevel,
});

export type AppEnv = z.infer<typeof appEnvSchema>;
export type SchedulerEnv = z.infer<typeof schedulerEnvSchema>;

function parseEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return result.data;
}

let appEnv: AppEnv | undefined;

/** Configuration for the web process, validated on first use and cached. */
export function getEnv(): AppEnv {
  appEnv ??= parseEnv(appEnvSchema, process.env);
  return appEnv;
}

/** Configuration for the scheduler process, which needs no database or storage access. */
export function getSchedulerEnv(): SchedulerEnv {
  return parseEnv(schedulerEnvSchema, process.env);
}
