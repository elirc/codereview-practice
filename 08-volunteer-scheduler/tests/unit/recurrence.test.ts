import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/lib/domain/dates';
import {
	MAX_CANDIDATES,
	isOccurrence,
	nextOccurrences,
	occurrences,
	sameRule,
	type RecurrenceRule
} from '../../src/lib/domain/recurrence';

function rule(overrides: Partial<RecurrenceRule>): RecurrenceRule {
	return {
		freq: 'DAILY',
		interval: 1,
		byWeekday: null,
		byMonthDay: null,
		dtstart: '2026-01-01',
		until: null,
		count: null,
		...overrides
	};
}

describe('daily rules', () => {
	it('steps by the interval from dtstart', () => {
		const r = rule({ interval: 3 });
		expect(occurrences(r, '2026-01-01', '2026-01-12')).toEqual([
			'2026-01-01',
			'2026-01-04',
			'2026-01-07',
			'2026-01-10'
		]);
	});

	it('keeps the interval phase when the range starts long after dtstart', () => {
		const r = rule({ interval: 3 });
		expect(occurrences(r, '2026-03-01', '2026-03-10')).toEqual([
			'2026-03-02',
			'2026-03-05',
			'2026-03-08'
		]);
	});

	it('generates nothing before dtstart', () => {
		const r = rule({ dtstart: '2026-01-10' });
		expect(occurrences(r, '2026-01-01', '2026-01-11')).toEqual(['2026-01-10', '2026-01-11']);
	});
});

describe('weekly rules', () => {
	it('skips off-interval weeks counted from the week of dtstart', () => {
		// 2026-01-07 is a Wednesday.
		const r = rule({ freq: 'WEEKLY', interval: 2, byWeekday: ['MO', 'TH'], dtstart: '2026-01-07' });
		expect(occurrences(r, '2026-01-01', '2026-02-08')).toEqual([
			'2026-01-08',
			'2026-01-19',
			'2026-01-22',
			'2026-02-02',
			'2026-02-05'
		]);
	});

	it('includes dtstart only when its weekday is selected', () => {
		const monday = rule({ freq: 'WEEKLY', byWeekday: ['MO'], dtstart: '2026-01-07' });
		expect(occurrences(monday, '2026-01-07', '2026-01-20')).toEqual(['2026-01-12', '2026-01-19']);
		const wednesday = rule({ freq: 'WEEKLY', byWeekday: ['WE'], dtstart: '2026-01-07' });
		expect(occurrences(wednesday, '2026-01-07', '2026-01-14')).toEqual([
			'2026-01-07',
			'2026-01-14'
		]);
	});

	it('orders several weekdays within a week regardless of input order', () => {
		const r = rule({ freq: 'WEEKLY', byWeekday: ['SU', 'TU'], dtstart: '2026-01-05' });
		expect(occurrences(r, '2026-01-05', '2026-01-18')).toEqual([
			'2026-01-06',
			'2026-01-11',
			'2026-01-13',
			'2026-01-18'
		]);
	});

	it('keeps the fortnightly phase when the range starts later', () => {
		const r = rule({ freq: 'WEEKLY', interval: 2, byWeekday: ['MO'], dtstart: '2026-01-05' });
		expect(occurrences(r, '2026-03-01', '2026-03-31')).toEqual([
			'2026-03-02',
			'2026-03-16',
			'2026-03-30'
		]);
	});

	it('generates nothing without weekdays', () => {
		const r = rule({ freq: 'WEEKLY', byWeekday: [] });
		expect(occurrences(r, '2026-01-01', '2026-12-31')).toEqual([]);
	});
});

describe('monthly rules', () => {
	it('only uses months that have day 31', () => {
		const r = rule({ freq: 'MONTHLY', byMonthDay: 31 });
		expect(occurrences(r, '2026-01-01', '2026-12-31')).toEqual([
			'2026-01-31',
			'2026-03-31',
			'2026-05-31',
			'2026-07-31',
			'2026-08-31',
			'2026-10-31',
			'2026-12-31'
		]);
	});

	it('uses the last day of each month for -1', () => {
		const r = rule({ freq: 'MONTHLY', byMonthDay: -1 });
		expect(occurrences(r, '2026-01-01', '2026-04-30')).toEqual([
			'2026-01-31',
			'2026-02-28',
			'2026-03-31',
			'2026-04-30'
		]);
		const leap = rule({ freq: 'MONTHLY', byMonthDay: -1, dtstart: '2028-02-01' });
		expect(occurrences(leap, '2028-02-01', '2028-02-29')).toEqual(['2028-02-29']);
	});

	it('skips February for day 29 in a non-leap year', () => {
		const r = rule({ freq: 'MONTHLY', byMonthDay: 29, dtstart: '2026-01-29' });
		expect(occurrences(r, '2026-01-01', '2026-04-30')).toEqual([
			'2026-01-29',
			'2026-03-29',
			'2026-04-29'
		]);
	});

	it('counts the interval from the month of dtstart', () => {
		const r = rule({ freq: 'MONTHLY', interval: 2, byMonthDay: 15, dtstart: '2026-01-15' });
		expect(occurrences(r, '2026-01-01', '2026-06-30')).toEqual([
			'2026-01-15',
			'2026-03-15',
			'2026-05-15'
		]);
		expect(occurrences(r, '2026-04-01', '2026-08-31')).toEqual(['2026-05-15', '2026-07-15']);
	});

	it('excludes a candidate earlier than dtstart in the first month', () => {
		const r = rule({ freq: 'MONTHLY', byMonthDay: 10, dtstart: '2026-01-20' });
		expect(occurrences(r, '2026-01-01', '2026-03-31')).toEqual(['2026-02-10', '2026-03-10']);
	});
});

describe('end conditions', () => {
	it('includes an until date that is itself an occurrence', () => {
		const r = rule({ interval: 3, until: '2026-01-10' });
		expect(occurrences(r, '2026-01-01', '2026-12-31')).toEqual([
			'2026-01-01',
			'2026-01-04',
			'2026-01-07',
			'2026-01-10'
		]);
	});

	it('stops after count dates even when the range starts later', () => {
		const r = rule({ count: 5 });
		expect(occurrences(r, '2026-01-01', '2026-12-31')).toHaveLength(5);
		expect(occurrences(r, '2026-01-03', '2026-12-31')).toEqual([
			'2026-01-03',
			'2026-01-04',
			'2026-01-05'
		]);
		expect(occurrences(r, '2026-01-06', '2026-12-31')).toEqual([]);
	});

	it('counts skipped months only when they produce a date', () => {
		const r = rule({ freq: 'MONTHLY', byMonthDay: 31, count: 3 });
		expect(occurrences(r, '2026-01-01', '2027-12-31')).toEqual([
			'2026-01-31',
			'2026-03-31',
			'2026-05-31'
		]);
	});

	it('leaves out skipped dates', () => {
		const r = rule({ freq: 'WEEKLY', byWeekday: ['MO', 'TH'], dtstart: '2026-01-05' });
		const skip = new Set(['2026-01-08', '2026-01-12']);
		expect(occurrences(r, '2026-01-05', '2026-01-18', { skip })).toEqual([
			'2026-01-05',
			'2026-01-15'
		]);
	});

	it('clips to the range end', () => {
		expect(occurrences(rule({}), '2026-01-01', '2026-01-03')).toEqual([
			'2026-01-01',
			'2026-01-02',
			'2026-01-03'
		]);
		expect(occurrences(rule({}), '2026-01-03', '2026-01-02')).toEqual([]);
	});
});

describe('candidate cap', () => {
	it('stops after the maximum number of candidates', () => {
		const result = occurrences(rule({}), '2026-01-01', '2035-12-31');
		expect(result).toHaveLength(MAX_CANDIDATES);
		expect(result.at(-1)).toBe(addDays('2026-01-01', MAX_CANDIDATES - 1));
	});

	it('terminates for a rule that can never match', () => {
		const r = rule({ freq: 'MONTHLY', interval: 12, byMonthDay: 31, dtstart: '2026-02-01' });
		expect(occurrences(r, '2026-01-01', '2999-12-31')).toEqual([]);
	});
});

describe('helpers', () => {
	it('previews the next occurrences from a date', () => {
		const r = rule({ freq: 'WEEKLY', byWeekday: ['FR'], dtstart: '2026-01-01' });
		expect(nextOccurrences(r, '2026-06-01', 3)).toEqual(['2026-06-05', '2026-06-12', '2026-06-19']);
	});

	it('checks single dates', () => {
		const r = rule({ freq: 'WEEKLY', byWeekday: ['FR'] });
		expect(isOccurrence(r, '2026-01-02')).toBe(true);
		expect(isOccurrence(r, '2026-01-03')).toBe(false);
	});

	it('compares rules ignoring weekday order', () => {
		const a = rule({ freq: 'WEEKLY', byWeekday: ['MO', 'TH'] });
		expect(sameRule(a, { ...a, byWeekday: ['TH', 'MO'] })).toBe(true);
		expect(sameRule(a, { ...a, byWeekday: ['MO'] })).toBe(false);
		expect(sameRule(a, { ...a, count: 4 })).toBe(false);
	});
});
