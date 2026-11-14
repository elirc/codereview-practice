import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wallTimeToInstant } from '../../src/lib/domain/time';
import { parseCsvText } from '../../src/lib/server/csv/parse';
import { rosterCsv, signupsCsv } from '../../src/lib/server/services/exports';
import { createShift, type OneOffShiftInput } from '../../src/lib/server/services/shifts';
import { signUp } from '../../src/lib/server/services/signups';
import { GET as signupsEndpoint } from '../../src/routes/exports/signups.csv/+server';
import { GET as rosterEndpoint } from '../../src/routes/shifts/[id]/roster.csv/+server';
import { createTestContext, TEST_ZONE, type TestContext } from '../support/context';
import { codeOf } from '../support/errors';
import { fakeEvent } from '../support/events';
import { createUser, type UserOverrides } from '../support/factories';

let ctx: TestContext;

beforeEach(() => {
	ctx = createTestContext(wallTimeToInstant('2026-01-05', '08:00', TEST_ZONE));
});

afterEach(() => ctx.close());

function shift(overrides: Partial<OneOffShiftInput> = {}) {
	return createShift(ctx, {
		title: 'Pantry',
		location: 'Hall',
		date: '2026-01-10',
		startTime: '09:00',
		durationMinutes: 120,
		capacity: 5,
		...overrides
	});
}

function volunteerOn(shiftId: string, overrides: UserOverrides) {
	const user = createUser(ctx, overrides);
	signUp(ctx, { userId: user.id, shiftId, actor: user });
	return user;
}

function parse(body: string) {
	expect(body.startsWith('\uFEFF')).toBe(true);
	const parsed = parseCsvText(body);
	if (!parsed.ok) throw new Error(parsed.error.message);
	return parsed;
}

describe('roster export', () => {
	it('guards formula-like cells and round-trips awkward names', () => {
		const target = shift();
		const names = ['=HYPERLINK("x")', 'Smith, Jo', 'Jo "JJ" Jones', 'Two\nLines'];
		names.forEach((name, index) =>
			volunteerOn(target.id, { name, phone: `+1555010000${index}` })
		);
		const { body, filename } = rosterCsv(ctx, target.id);
		expect(filename).toBe('roster-2026-01-10-pantry.csv');
		expect(body).toContain(`"'=HYPERLINK(""x"")"`);
		expect(body.endsWith('\r\n')).toBe(true);

		const parsed = parse(body);
		const nameColumn = parsed.header.fields.indexOf('name');
		const phoneColumn = parsed.header.fields.indexOf('phone');
		const exported = parsed.rows.map((row) => row.fields[nameColumn].replace(/^'(?==)/, ''));
		expect([...exported].sort()).toEqual([...names].sort());
		const guarded = parsed.rows.find((row) => row.fields[nameColumn] === `'${names[0]}`);
		expect(guarded?.fields[phoneColumn]).toBe("'+15550100000");
	});

	it('writes timestamps with the organisation offset', () => {
		const target = shift({ date: '2026-07-01' });
		volunteerOn(target.id, { name: 'Summer' });
		const parsed = parse(rosterCsv(ctx, target.id).body);
		const startsAt = parsed.header.fields.indexOf('shift_starts_at');
		expect(parsed.rows[0].fields[startsAt]).toBe('2026-07-01T09:00:00-04:00');
	});
});

describe('signups export', () => {
	it('selects shifts by organisation-local start date, inclusive of the end date', () => {
		const late = shift({ date: '2026-01-10', startTime: '23:30', durationMinutes: 60 });
		const midnight = shift({ date: '2026-01-11', startTime: '00:00', durationMinutes: 60 });
		volunteerOn(late.id, { name: 'Late' });
		volunteerOn(midnight.id, { name: 'Midnight' });
		const parsed = parse(signupsCsv(ctx, '2026-01-09', '2026-01-10').body);
		const shiftColumn = parsed.header.fields.indexOf('shift_id');
		expect(parsed.rows.map((row) => row.fields[shiftColumn])).toEqual([late.id]);
	});

	it('allows at most 366 days', () => {
		expect(() => signupsCsv(ctx, '2026-01-01', '2027-01-01')).not.toThrow();
		expect(codeOf(() => signupsCsv(ctx, '2026-01-01', '2027-01-02'))).toBe('validation_failed');
	});
});

describe('export endpoints', () => {
	it('serve CSV attachments to coordinators', async () => {
		const target = shift();
		const coordinator = createUser(ctx, { role: 'coordinator' });
		const { event } = fakeEvent({ ctx, user: coordinator, params: { id: target.id } });
		const response = await rosterEndpoint(event);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="roster-2026-01-10-pantry.csv"'
		);
	});

	it('answer volunteers with a 403 error envelope', async () => {
		const target = shift();
		const volunteer = createUser(ctx);
		const { event } = fakeEvent({ ctx, user: volunteer, params: { id: target.id } });
		const response = await rosterEndpoint(event);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: {
				code: 'forbidden',
				message: 'You do not have permission to do that.',
				requestId: 'test-request'
			}
		});
	});

	it('require a session', async () => {
		const { event } = fakeEvent({
			ctx,
			user: null,
			url: 'http://localhost/exports/signups.csv?from=2026-01-01&to=2026-01-31'
		});
		expect((await signupsEndpoint(event)).status).toBe(401);
	});

	it('report bad ranges and unknown shifts in the envelope', async () => {
		const coordinator = createUser(ctx, { role: 'coordinator' });
		const range = fakeEvent({
			ctx,
			user: coordinator,
			url: 'http://localhost/exports/signups.csv?from=2026-02-01&to=2026-01-01'
		});
		const rangeResponse = await signupsEndpoint(range.event);
		expect(rangeResponse.status).toBe(400);
		const body = await rangeResponse.json();
		expect(body.error.code).toBe('validation_failed');
		expect(body.error.details.fields[0].path).toBe('to');

		const missing = fakeEvent({ ctx, user: coordinator, params: { id: 'not-a-uuid' } });
		const missingResponse = await rosterEndpoint(missing.event);
		expect(missingResponse.status).toBe(404);
		expect((await missingResponse.json()).error.code).toBe('not_found');
	});
});
