import type { Logger } from '$lib/server/logger';

declare global {
	namespace App {
		interface Error {
			code: string;
			message: string;
			requestId?: string;
		}
		interface Locals {
			requestId: string;
			log: Logger;
		}
	}
}

export {};
