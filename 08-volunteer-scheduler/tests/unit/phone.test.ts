import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/domain/phone';

describe('normalizePhone', () => {
	it.each([
		['(555) 010-1234', '+15550101234'],
		['555.010.1234', '+15550101234'],
		['5550101234', '+15550101234'],
		['1 555 010 1234', '+15550101234'],
		['+1 (555) 010-1234', '+15550101234'],
		['+44 20 7946 0958', '+442079460958'],
		['  +15550101234  ', '+15550101234']
	])('normalises %s', (input, expected) => {
		expect(normalizePhone(input)).toBe(expected);
	});

	it.each([
		'12345',
		'25550101234',
		'555-010-12345',
		'555 010 123x',
		'+0 555 010 1234',
		'1+5550101234',
		''
	])('rejects %s', (input) => {
		expect(normalizePhone(input)).toBeNull();
	});
});
