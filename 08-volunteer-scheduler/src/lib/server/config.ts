import { existsSync } from 'node:fs';
import { IANAZone } from 'luxon';
import { z } from 'zod';

const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
	DATABASE_PATH: z.string().trim().min(1).default('data/volunteer-scheduler.sqlite'),
	ORG_TIMEZONE: z
		.string()
		.trim()
		.default('America/New_York')
		.refine((zone) => IANAZone.isValidZone(zone), 'must be a valid IANA time zone'),
	LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
	SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
	EMAIL_PROVIDER: z.enum(['console']).default('console'),
	SMS_PROVIDER: z.enum(['console']).default('console')
});

export interface Config {
	nodeEnv: 'development' | 'test' | 'production';
	databasePath: string;
	orgTimezone: string;
	logLevel: string;
	sessionTtlDays: number;
	emailProvider: 'console';
	smsProvider: 'console';
}

/** Parses and validates configuration; throws with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		const problems = result.error.issues
			.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
			.join('; ');
		throw new Error(`Invalid configuration: ${problems}`);
	}
	const values = result.data;
	return {
		nodeEnv: values.NODE_ENV,
		databasePath: values.DATABASE_PATH,
		orgTimezone: values.ORG_TIMEZONE,
		logLevel: values.LOG_LEVEL,
		sessionTtlDays: values.SESSION_TTL_DAYS,
		emailProvider: values.EMAIL_PROVIDER,
		smsProvider: values.SMS_PROVIDER
	};
}

let cached: Config | undefined;

/** Process-wide configuration, read once. A local `.env` file is loaded if present. */
export function getConfig(): Config {
	if (!cached) {
		if (existsSync('.env')) process.loadEnvFile('.env');
		cached = loadConfig();
	}
	return cached;
}
