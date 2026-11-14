import type {
	EmailMessage,
	EmailProvider,
	SendOptions,
	SendResult,
	SmsMessage,
	SmsProvider
} from '../../src/lib/server/outbox/providers';

type Behaviour = () => Error | null;

class Recorder<M> {
	readonly calls: { message: M; options: SendOptions }[] = [];
	private readonly queued: (Error | null)[] = [];
	private fallback: Behaviour = () => null;

	constructor(private readonly prefix: string) {}

	/** Results for the next calls, in order: an Error to throw or null to succeed. */
	queue(...results: (Error | null)[]): void {
		this.queued.push(...results);
	}

	always(behaviour: Behaviour): void {
		this.fallback = behaviour;
	}

	async send(message: M, options: SendOptions): Promise<SendResult> {
		this.calls.push({ message, options });
		const next = this.queued.length > 0 ? this.queued.shift() : this.fallback();
		if (next) throw next;
		return { providerMessageId: `${this.prefix}-${this.calls.length}` };
	}
}

export class RecordingEmailProvider extends Recorder<EmailMessage> implements EmailProvider {
	constructor() {
		super('email');
	}
}

export class RecordingSmsProvider extends Recorder<SmsMessage> implements SmsProvider {
	constructor() {
		super('sms');
	}
}

export function recordingProviders() {
	return { email: new RecordingEmailProvider(), sms: new RecordingSmsProvider() };
}
