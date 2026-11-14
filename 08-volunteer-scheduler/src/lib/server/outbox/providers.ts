import { createHash } from 'node:crypto';
import type { Config } from '../config';
import type { Logger } from '../logger';

export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
}

export interface SmsMessage {
	to: string;
	text: string;
}

export interface SendOptions {
	/** Stable across retries of the same notification. */
	idempotencyKey: string;
}

export interface SendResult {
	providerMessageId: string;
}

export interface EmailProvider {
	send(message: EmailMessage, options: SendOptions): Promise<SendResult>;
}

export interface SmsProvider {
	send(message: SmsMessage, options: SendOptions): Promise<SendResult>;
}

/** The provider could not accept the message now; retrying may succeed. */
export class TransientProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TransientProviderError';
	}
}

/** The provider will never accept this message (for example an invalid number). */
export class PermanentProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PermanentProviderError';
	}
}

function messageId(prefix: string, idempotencyKey: string): string {
	return `${prefix}-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 20)}`;
}

export class ConsoleEmailProvider implements EmailProvider {
	constructor(private readonly logger: Logger) {}

	async send(message: EmailMessage, options: SendOptions): Promise<SendResult> {
		this.logger.info(
			{ channel: 'email', to: message.to, subject: message.subject, key: options.idempotencyKey },
			'email delivered to console'
		);
		return { providerMessageId: messageId('console-email', options.idempotencyKey) };
	}
}

export class ConsoleSmsProvider implements SmsProvider {
	constructor(private readonly logger: Logger) {}

	async send(message: SmsMessage, options: SendOptions): Promise<SendResult> {
		this.logger.info(
			{ channel: 'sms', to: message.to, length: message.text.length, key: options.idempotencyKey },
			'sms delivered to console'
		);
		return { providerMessageId: messageId('console-sms', options.idempotencyKey) };
	}
}

export interface Providers {
	email: EmailProvider;
	sms: SmsProvider;
}

export function createProviders(config: Config, logger: Logger): Providers {
	const email: Record<Config['emailProvider'], () => EmailProvider> = {
		console: () => new ConsoleEmailProvider(logger)
	};
	const sms: Record<Config['smsProvider'], () => SmsProvider> = {
		console: () => new ConsoleSmsProvider(logger)
	};
	return { email: email[config.emailProvider](), sms: sms[config.smsProvider]() };
}
