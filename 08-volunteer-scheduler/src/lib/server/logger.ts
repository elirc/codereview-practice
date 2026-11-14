import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
	return pino({
		level,
		base: { service: 'volunteer-scheduler' },
		timestamp: pino.stdTimeFunctions.isoTime,
		redact: {
			paths: [
				'password',
				'*.password',
				'token',
				'*.token',
				'passwordHash',
				'*.passwordHash',
				'headers.cookie',
				'*.headers.cookie'
			],
			censor: '[redacted]'
		}
	});
}
