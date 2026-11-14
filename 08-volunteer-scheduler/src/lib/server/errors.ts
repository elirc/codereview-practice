import type { ZodError } from 'zod';

export interface ErrorBody {
	code: string;
	message: string;
	details?: Record<string, unknown>;
	requestId?: string;
}

export interface FieldError {
	path: string;
	message: string;
}

/** An expected failure with a stable code and the HTTP status it maps to. */
export class DomainError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: Record<string, unknown>;

	constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = 'DomainError';
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

export function notFound(message = 'Not found.'): DomainError {
	return new DomainError('not_found', 404, message);
}

export function zodFieldErrors(error: ZodError): FieldError[] {
	return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

export function validationError(error: ZodError): DomainError {
	return new DomainError('validation_failed', 400, 'Some fields are invalid.', {
		fields: zodFieldErrors(error)
	});
}

export function errorEnvelope(body: ErrorBody): { error: ErrorBody } {
	return { error: body };
}

export const INTERNAL_ERROR_MESSAGE = 'An unexpected error occurred.';
