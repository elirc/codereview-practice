import { fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import type { z } from 'zod';
import { DomainError, validationError, type ErrorBody } from './errors';

export type FormValues = Record<string, string | string[]>;

export interface ActionErrorData {
	error: ErrorBody;
	values: FormValues;
}

const SECRET_FIELDS = new Set(['password', 'passwordConfirm']);

function collect(form: FormData, arrayFields: readonly string[], includeSecrets: boolean) {
	const values: FormValues = {};
	for (const key of new Set(form.keys())) {
		if (!includeSecrets && SECRET_FIELDS.has(key)) continue;
		const entries = form.getAll(key).filter((entry): entry is string => typeof entry === 'string');
		values[key] = arrayFields.includes(key) || entries.length > 1 ? entries : (entries[0] ?? '');
	}
	for (const key of arrayFields) values[key] ??= [];
	return values;
}

/** Converts a thrown DomainError into the form-action failure shape; rethrows anything else. */
export function actionFailure(
	event: RequestEvent,
	err: unknown,
	values: FormValues = {}
): ActionFailure<ActionErrorData> {
	if (err instanceof DomainError) {
		return fail(err.status, {
			error: {
				code: err.code,
				message: err.message,
				details: err.details,
				requestId: event.locals.requestId
			},
			values
		});
	}
	throw err;
}

export type Parsed<T> =
	| { ok: true; data: T; values: FormValues }
	| { ok: false; failure: ActionFailure<ActionErrorData> };

/** Reads the request's form data and validates it; `values` excludes password fields. */
export async function parseForm<S extends z.ZodTypeAny>(
	event: RequestEvent,
	schema: S,
	arrayFields: readonly string[] = []
): Promise<Parsed<z.output<S>>> {
	const form = await event.request.formData();
	return parseFormData(event, form, schema, arrayFields);
}

export function parseFormData<S extends z.ZodTypeAny>(
	event: RequestEvent,
	form: FormData,
	schema: S,
	arrayFields: readonly string[] = []
): Parsed<z.output<S>> {
	const values = collect(form, arrayFields, false);
	const result = schema.safeParse(collect(form, arrayFields, true));
	if (!result.success) {
		return { ok: false, failure: actionFailure(event, validationError(result.error), values) };
	}
	return { ok: true, data: result.data, values };
}

export type Attempt<T> =
	| { ok: true; value: T }
	| { ok: false; failure: ActionFailure<ActionErrorData> };

/** Runs domain work for an action, turning DomainErrors into failures. */
export function attempt<T>(event: RequestEvent, values: FormValues, work: () => T): Attempt<T> {
	try {
		return { ok: true, value: work() };
	} catch (err) {
		return { ok: false, failure: actionFailure(event, err, values) };
	}
}
