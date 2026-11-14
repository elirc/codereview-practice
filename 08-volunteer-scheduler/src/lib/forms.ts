export interface FormErrorBody {
	code: string;
	message: string;
	details?: Record<string, unknown>;
	requestId?: string;
}

type Values = Record<string, string | string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** The error from a failed form action, if any. */
export function errorOf(form: unknown): FormErrorBody | null {
	if (isRecord(form) && isRecord(form.error)) return form.error as unknown as FormErrorBody;
	return null;
}

/** Submitted values echoed back by a failed form action. */
export function valuesOf(form: unknown): Values {
	if (isRecord(form) && isRecord(form.values)) return form.values as Values;
	return {};
}

export function fieldErrors(form: unknown): { path: string; message: string }[] {
	const details = errorOf(form)?.details;
	if (details && Array.isArray(details.fields)) {
		return details.fields as { path: string; message: string }[];
	}
	return [];
}

export function fieldError(form: unknown, path: string): string | undefined {
	return fieldErrors(form).find((field) => field.path === path)?.message;
}

/** Prefers a value the user just submitted over the stored one. */
export function valueOr(form: unknown, key: string, fallback: string | number | null | undefined) {
	const submitted = valuesOf(form)[key];
	if (typeof submitted === 'string') return submitted;
	return fallback === null || fallback === undefined ? '' : String(fallback);
}
