import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findInvite } from '../../src/lib/server/auth/invite';
import { importRuns, outbox, users, type ImportMode } from '../../src/lib/server/db/schema';
import { importVolunteers, type ImportReport } from '../../src/lib/server/services/import';
import { actions as importActions } from '../../src/routes/manage/volunteers/import/+page.server';
import { createTestContext, type TestContext } from '../support/context';
import { codeOf } from '../support/errors';
import { fakeEvent, failureOf, httpStatus, thrown } from '../support/events';
import { createUser } from '../support/factories';

let ctx: TestContext;
let coordinatorId: string;

beforeEach(() => {
	ctx = createTestContext(Date.UTC(2026, 0, 5, 15));
	coordinatorId = createUser(ctx, { role: 'coordinator', email: 'coord@example.org' }).id;
});

afterEach(() => ctx.close());

function run(text: string, mode: ImportMode = 'commit'): ImportReport {
	return importVolunteers(ctx, {
		actorId: coordinatorId,
		filename: 'volunteers.csv',
		mode,
		bytes: new TextEncoder().encode(text)
	});
}

function user(email: string) {
	return ctx.db.select().from(users).where(eq(users.email, email)).get();
}

function errorCodes(report: ImportReport) {
	return report.errors.map((error) => [error.rowNumber, error.code]);
}

describe('file-level checks', () => {
	it('matches headers case-insensitively after trimming and warns about unknown ones', () => {
		const report = run(' Email ,NAME,Shoe size\r\nada@example.org,Ada Lovelace,7\r\n');
		expect(report).toMatchObject({ totalRows: 1, created: 1, failed: 0 });
		expect(report.warnings).toEqual([
			{ code: 'unknown_column', column: 'shoe size', message: 'Ignored column "shoe size".' }
		]);
		expect(user('ada@example.org')?.name).toBe('Ada Lovelace');
	});

	it('requires the name and email columns', () => {
		expect(codeOf(() => run('name,phone\nAda,5550101234\n'))).toBe('missing_columns');
	});

	it('rejects a duplicated header', () => {
		expect(codeOf(() => run('name,email,EMAIL\nAda,a@example.org,b@example.org\n'))).toBe(
			'duplicate_columns'
		);
	});

	it('rejects empty files and unterminated quotes, importing nothing', () => {
		expect(codeOf(() => run(''))).toBe('missing_header');
		let details: unknown;
		try {
			run('name,email\nAda,ada@example.org\n"Bob,bob@example.org\n');
		} catch (err) {
			details = err;
		}
		expect(details).toMatchObject({ code: 'unterminated_quote', details: { line: 3 } });
		expect(user('ada@example.org')).toBeUndefined();
	});

	it('accepts a header-only file as zero rows', () => {
		expect(run('name,email\n')).toMatchObject({ totalRows: 0, created: 0, failed: 0 });
	});
});

describe('row validation', () => {
	it('reports each kind of row error with its row and line', () => {
		const report = run(
			[
				'name,email,phone,role,sms_opt_in',
				',empty-name@example.org,,,',
				'Bad Email,not-an-email,,,',
				'Bad Phone,phone@example.org,12345,,',
				'Admin Hopeful,admin@example.org,,admin,',
				'Unsure,unsure@example.org,,,maybe',
				'No Phone,nophone@example.org,,,yes',
				'Short,short@example.org',
				'Long,long@example.org,,,,extra',
				'"Quoted"x,quoted@example.org,,,'
			].join('\n')
		);
		expect(errorCodes(report)).toEqual([
			[1, 'invalid_name'],
			[2, 'invalid_email'],
			[3, 'invalid_phone'],
			[4, 'invalid_role'],
			[5, 'invalid_boolean'],
			[6, 'sms_requires_phone'],
			[7, 'wrong_field_count'],
			[8, 'wrong_field_count'],
			[9, 'malformed_quotes']
		]);
		expect(report.errors[2]).toMatchObject({ line: 4, column: 'phone' });
		expect(report).toMatchObject({ totalRows: 9, created: 0, failed: 9 });
	});

	it('normalises phone numbers and booleans', () => {
		run('name,email,phone,sms_opt_in\nGrace,grace@example.org,(555) 010-1234,YES\n');
		expect(user('grace@example.org')).toMatchObject({ phone: '+15550101234', smsOptIn: true });
	});

	it('keeps the first of two rows with the same email in different case', () => {
		const report = run('name,email\nFirst,Same@Example.org\nSecond,same@example.org\n');
		expect(report.errors).toEqual([
			{
				rowNumber: 2,
				line: 3,
				column: 'email',
				code: 'duplicate_in_file',
				message: 'This email already appears in row 1.'
			}
		]);
		expect(user('same@example.org')?.name).toBe('First');
	});
});

describe('existing users', () => {
	it('updates name, phone and SMS preference but never the role', () => {
		createUser(ctx, { email: 'vol@example.org', name: 'Old Name', role: 'volunteer' });
		const report = run(
			'name,email,phone,role,sms_opt_in\nNew Name,VOL@example.org,555 010 9999,coordinator,1\n'
		);
		expect(report).toMatchObject({ created: 0, updated: 1, failed: 0 });
		expect(user('vol@example.org')).toMatchObject({
			name: 'New Name',
			phone: '+15550109999',
			smsOptIn: true,
			role: 'volunteer'
		});
	});

	it('leaves values for columns the file does not have', () => {
		createUser(ctx, { email: 'keep@example.org', phone: '+15550100000', smsOptIn: true });
		run('name,email\nKept,keep@example.org\n');
		expect(user('keep@example.org')).toMatchObject({
			name: 'Kept',
			phone: '+15550100000',
			smsOptIn: true
		});
	});

	it('never modifies an admin', () => {
		createUser(ctx, { email: 'boss@example.org', name: 'Boss', role: 'admin' });
		const report = run('name,email\nRenamed,boss@example.org\n');
		expect(errorCodes(report)).toEqual([[1, 'protected_user']]);
		expect(user('boss@example.org')?.name).toBe('Boss');
	});
});

describe('modes', () => {
	function hundredRows() {
		const lines = ['name,email,phone'];
		for (let i = 1; i <= 100; i++) {
			const bad = i === 10 || i === 50 || i === 99;
			lines.push(`Person ${i},person${i}@example.org,${bad ? '12345' : ''}`);
		}
		return lines.join('\r\n');
	}

	it('dry run reports the same counts as commit without changing anything', () => {
		const before = ctx.db.select().from(users).all().length;
		const dry = run(hundredRows(), 'dry_run');
		expect(ctx.db.select().from(users).all()).toHaveLength(before);
		expect(dry.invites).toEqual([]);

		const committed = run(hundredRows(), 'commit');
		for (const report of [dry, committed]) {
			expect(report).toMatchObject({ totalRows: 100, created: 97, updated: 0, failed: 3 });
			expect(report.errors.map((e) => e.rowNumber)).toEqual([10, 50, 99]);
		}
		expect(ctx.db.select().from(users).all()).toHaveLength(before + 97);
	});

	it('creates new users without passwords, with invite links and no notifications', () => {
		const report = run('name,email\nNew Person,new@example.org\n');
		const created = user('new@example.org');
		expect(created).toMatchObject({ passwordHash: null, role: 'volunteer', emailOptIn: true });
		expect(report.invites).toHaveLength(1);
		expect(findInvite(ctx, report.invites[0].token)?.userId).toBe(created?.id);
		expect(ctx.db.select().from(outbox).all()).toHaveLength(0);
	});

	it('imports nothing when the commit transaction fails', () => {
		ctx.connection.sqlite.exec(`
			CREATE TRIGGER reject_import BEFORE INSERT ON users
			WHEN NEW.email = 'boom@example.org'
			BEGIN SELECT RAISE(ABORT, 'rejected'); END;
		`);
		const before = ctx.db.select().from(users).all().length;
		expect(() =>
			run('name,email\nFine,fine@example.org\nBoom,boom@example.org\nAlso,also@example.org\n')
		).toThrow(/rejected/);
		expect(ctx.db.select().from(users).all()).toHaveLength(before);
		expect(ctx.db.select().from(importRuns).all()).toHaveLength(0);
	});

	it('saves a record of every run', () => {
		run('name,email\nOk,ok@example.org\n,missing@example.org\n', 'dry_run');
		const [saved] = ctx.db.select().from(importRuns).all();
		expect(saved).toMatchObject({
			userId: coordinatorId,
			filename: 'volunteers.csv',
			mode: 'dry_run',
			totalRows: 2,
			created: 1,
			updated: 0,
			failed: 1
		});
		expect(JSON.parse(saved.errors)).toEqual([
			expect.objectContaining({ rowNumber: 2, code: 'invalid_name' })
		]);
	});
});

describe('upload action', () => {
	function upload(name: string, content: string, mode = 'dry_run') {
		const form = new FormData();
		form.append('mode', mode);
		form.append('file', new File([content], name, { type: 'text/csv' }));
		return form;
	}

	it('returns the report with invite links for a coordinator', async () => {
		const coordinator = user('coord@example.org');
		const { event } = fakeEvent({
			ctx,
			user: coordinator,
			url: 'http://volunteers.test/manage/volunteers/import',
			form: upload('people.csv', 'name,email\nZed,zed@example.org\n', 'commit')
		});
		const result = (await importActions.default(event)) as {
			report: { created: number; invites: { url: string }[] };
		};
		expect(result.report.created).toBe(1);
		expect(result.report.invites[0].url).toMatch(/^http:\/\/volunteers\.test\/invite\/[\w-]{43}$/);
	});

	it('turns file-level problems into form errors', async () => {
		const coordinator = user('coord@example.org');
		const { event } = fakeEvent({
			ctx,
			user: coordinator,
			form: upload('people.csv', 'phone\n555\n')
		});
		expect(failureOf(await importActions.default(event))).toEqual({
			status: 400,
			code: 'missing_columns'
		});
	});

	it('rejects non-CSV uploads and volunteers', async () => {
		const coordinator = user('coord@example.org');
		const form = new FormData();
		form.append('mode', 'dry_run');
		form.append('file', new File(['x'], 'photo.png', { type: 'image/png' }));
		const asCoordinator = fakeEvent({ ctx, user: coordinator, form });
		expect(failureOf(await importActions.default(asCoordinator.event))?.status).toBe(415);

		const volunteer = createUser(ctx);
		const asVolunteer = fakeEvent({ ctx, user: volunteer, form: upload('a.csv', 'name,email\n') });
		expect(httpStatus(await thrown(() => importActions.default(asVolunteer.event)))).toBe(403);
	});
});
