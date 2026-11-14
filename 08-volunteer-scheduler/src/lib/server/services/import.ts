import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { normalizePhone } from '../../domain/phone';
import { createInvite } from '../auth/invite';
import type { AppContext } from '../context';
import { IMMEDIATE, type Tx } from '../db/client';
import { importRuns, users, type ImportMode, type UserRow } from '../db/schema';
import { parseCsv, type CsvFileError, type CsvRecord } from '../csv/parse';
import { parseBoolean } from '../csv/values';
import { DomainError } from '../errors';

export const IMPORT_COLUMNS = ['name', 'email', 'phone', 'role', 'sms_opt_in'] as const;
type Column = (typeof IMPORT_COLUMNS)[number];

export interface ImportRowError {
	rowNumber: number;
	line: number;
	column?: string;
	code: string;
	message: string;
}

export interface ImportWarning {
	code: string;
	message: string;
	column?: string;
}

export interface ImportInvite {
	rowNumber: number;
	email: string;
	name: string;
	token: string;
}

export interface ImportReport {
	runId: string;
	mode: ImportMode;
	totalRows: number;
	created: number;
	updated: number;
	failed: number;
	warnings: ImportWarning[];
	errors: ImportRowError[];
	/** Single-use password links for created users (commit mode only). */
	invites: ImportInvite[];
}

export interface ImportInput {
	actorId: string;
	filename: string;
	mode: ImportMode;
	bytes: Uint8Array;
}

interface CandidateRow {
	rowNumber: number;
	line: number;
	name: string;
	email: string;
	/** undefined when the file has no phone column. */
	phone: string | null | undefined;
	role: 'volunteer' | 'coordinator';
	/** undefined when the file has no sms_opt_in column. */
	smsOptIn: boolean | undefined;
}

const FILE_ERROR_STATUS: Record<CsvFileError['code'], number> = {
	file_too_large: 413,
	too_many_rows: 413,
	invalid_encoding: 400,
	unterminated_quote: 400,
	missing_header: 400,
	malformed_header: 400
};

const IMPORTABLE_ROLES = ['volunteer', 'coordinator'] as const;

const nameSchema = z
	.string()
	.trim()
	.min(1, 'Name is required.')
	.max(120, 'Name must be at most 120 characters.');
const emailSchema = z.string().trim().toLowerCase().email('Email address is not valid.');
const roleSchema = z
	.string()
	.trim()
	.toLowerCase()
	.transform((value) => value || 'volunteer')
	.pipe(z.enum(IMPORTABLE_ROLES, { message: 'Role must be volunteer or coordinator.' }));
const phoneSchema = z.string().transform((value, ctx) => {
	if (value.trim() === '') return null;
	const phone = normalizePhone(value);
	if (phone) return phone;
	ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Phone number is not valid.' });
	return z.NEVER;
});
const smsSchema = z.string().transform((value, ctx) => {
	if (value.trim() === '') return false;
	const parsed = parseBoolean(value);
	if (parsed !== null) return parsed;
	ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use true/false, yes/no or 1/0.' });
	return z.NEVER;
});

interface HeaderMap {
	columns: Map<Column, number>;
	warnings: ImportWarning[];
}

function readHeader(header: CsvRecord): HeaderMap {
	const names = header.fields.map((field) => field.trim().toLowerCase());
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) {
			throw new DomainError('duplicate_columns', 400, `The column "${name}" appears twice.`, {
				column: name
			});
		}
		seen.add(name);
	}
	const missing = ['name', 'email'].filter((name) => !seen.has(name));
	if (missing.length > 0) {
		throw new DomainError(
			'missing_columns',
			400,
			`Missing required column(s): ${missing.join(', ')}.`,
			{ columns: missing }
		);
	}
	const columns = new Map<Column, number>();
	const warnings: ImportWarning[] = [];
	names.forEach((name, index) => {
		if ((IMPORT_COLUMNS as readonly string[]).includes(name)) {
			columns.set(name as Column, index);
		}
		else {
			warnings.push({ code: 'unknown_column', column: name, message: `Ignored column "${name}".` });
		}
	});
	return { columns, warnings };
}

function validateRow(
	record: CsvRecord,
	columns: Map<Column, number>,
	width: number
): { row?: CandidateRow; errors: ImportRowError[] } {
	const at = { rowNumber: record.rowNumber, line: record.line };
	if (record.error) {
		return { errors: [{ ...at, code: record.error.code, message: record.error.message }] };
	}
	if (record.fields.length !== width) {
		return {
			errors: [
				{
					...at,
					code: 'wrong_field_count',
					message: `Expected ${width} fields but found ${record.fields.length}.`
				}
			]
		};
	}
	const errors: ImportRowError[] = [];
	function check<T>(column: Column, code: string, schema: z.ZodType<T, z.ZodTypeDef, string>) {
		const index = columns.get(column);
		if (index === undefined) return undefined;
		const result = schema.safeParse(record.fields[index]);
		if (result.success) return result.data;
		errors.push({ ...at, column, code, message: result.error.issues[0]?.message ?? 'Invalid.' });
		return undefined;
	}
	const name = check('name', 'invalid_name', nameSchema);
	const email = check('email', 'invalid_email', emailSchema);
	const phone = check('phone', 'invalid_phone', phoneSchema);
	const role = check('role', 'invalid_role', roleSchema) ?? 'volunteer';
	const smsOptIn = check('sms_opt_in', 'invalid_boolean', smsSchema);
	if (errors.length > 0 || name === undefined || email === undefined) {
		return { errors, row: email === undefined ? undefined : partialRow(at, email) };
	}
	return { errors, row: { ...at, name, email, phone, role, smsOptIn } };
}

/** Rows that failed validation still claim their email for duplicate detection. */
function partialRow(at: { rowNumber: number; line: number }, email: string): CandidateRow {
	return { ...at, name: '', email, phone: undefined, role: 'volunteer', smsOptIn: undefined };
}

function loadExisting(tx: Tx, emails: string[]): Map<string, UserRow> {
	const found = new Map<string, UserRow>();
	for (let i = 0; i < emails.length; i += 500) {
		const chunk = emails.slice(i, i + 500);
		for (const user of tx.select().from(users).where(inArray(users.email, chunk)).all()) {
			found.set(user.email, user);
		}
	}
	return found;
}

/**
 * Validates a volunteer CSV and, in commit mode, applies every valid row in
 * one transaction. Both modes return the same report and record the run.
 */
export function importVolunteers(ctx: AppContext, input: ImportInput): ImportReport {
	const parsed = parseCsv(input.bytes);
	if (!parsed.ok) {
		const { code, message, line } = parsed.error;
		throw new DomainError(code, FILE_ERROR_STATUS[code], message, line ? { line } : undefined);
	}
	const { columns, warnings } = readHeader(parsed.header);
	const width = parsed.header.fields.length;

	const errors: ImportRowError[] = [];
	const candidates: CandidateRow[] = [];
	const firstRowByEmail = new Map<string, number>();
	for (const record of parsed.rows) {
		const result = validateRow(record, columns, width);
		const rowErrors = [...result.errors];
		if (result.row) {
			const first = firstRowByEmail.get(result.row.email);
			if (first === undefined) firstRowByEmail.set(result.row.email, result.row.rowNumber);
			else {
				rowErrors.push({
					rowNumber: record.rowNumber,
					line: record.line,
					column: 'email',
					code: 'duplicate_in_file',
					message: `This email already appears in row ${first}.`
				});
			}
		}
		if (rowErrors.length > 0) errors.push(...rowErrors);
		else if (result.row) candidates.push(result.row);
	}

	const now = ctx.now();
	const run = (tx: Tx): ImportReport => {
		const existing = loadExisting(tx, candidates.map((row) => row.email));
		const creates: CandidateRow[] = [];
		const updates: { row: CandidateRow; user: UserRow }[] = [];
		for (const row of candidates) {
			const user = existing.get(row.email);
			const phone = row.phone !== undefined ? row.phone : (user?.phone ?? null);
			const smsOptIn = row.smsOptIn ?? user?.smsOptIn ?? false;
			const at = { rowNumber: row.rowNumber, line: row.line };
			if (user?.role === 'admin') {
				errors.push({
					...at,
					column: 'email',
					code: 'protected_user',
					message: 'Admin accounts cannot be changed by import.'
				});
			} else if (smsOptIn && !phone) {
				errors.push({
					...at,
					column: 'sms_opt_in',
					code: 'sms_requires_phone',
					message: 'Text messages need a phone number.'
				});
			} else if (user) {
				updates.push({ row, user });
			} else {
				creates.push(row);
			}
		}

		const invites: ImportInvite[] = [];
		if (input.mode === 'commit') {
			for (const row of creates) {
				const id = randomUUID();
				tx.insert(users)
					.values({
						id,
						email: row.email,
						name: row.name,
						phone: row.phone ?? null,
						role: row.role,
						smsOptIn: row.smsOptIn ?? false,
						createdAt: now
					})
					.run();
				const token = createInvite(tx, id, now);
				invites.push({ rowNumber: row.rowNumber, email: row.email, name: row.name, token });
			}
			for (const { row, user } of updates) {
				tx.update(users)
					.set({
						name: row.name,
						...(row.phone !== undefined ? { phone: row.phone } : {}),
						...(row.smsOptIn !== undefined ? { smsOptIn: row.smsOptIn } : {})
					})
					.where(eq(users.id, user.id))
					.run();
			}
		}

		errors.sort((a, b) => a.rowNumber - b.rowNumber);
		const failedRows = new Set(errors.map((error) => error.rowNumber)).size;
		const runId = randomUUID();
		tx.insert(importRuns)
			.values({
				id: runId,
				userId: input.actorId,
				filename: input.filename,
				mode: input.mode,
				totalRows: parsed.rows.length,
				created: creates.length,
				updated: updates.length,
				failed: failedRows,
				errors: JSON.stringify(errors),
				createdAt: now
			})
			.run();
		return {
			runId,
			mode: input.mode,
			totalRows: parsed.rows.length,
			created: creates.length,
			updated: updates.length,
			failed: failedRows,
			warnings,
			errors,
			invites
		};
	};

	return input.mode === 'commit' ? ctx.db.transaction(run, IMMEDIATE) : run(ctx.db);
}
