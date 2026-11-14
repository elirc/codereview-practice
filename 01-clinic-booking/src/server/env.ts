import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), "must be a postgres connection string"),
  APP_ORIGIN: z
    .string()
    .url()
    .transform((value) => new URL(value).origin),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  MAILER: z.enum(["console", "memory"]).default("console"),
  MAIL_FROM: z.string().email().default("appointments@clinic.example"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return parsed.data;
}

export const env = loadEnv();
