import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/lib/server/csv/parse';
import { formatCell, toCsv } from '../../src/lib/server/csv/write';
import { parseBoolean } from '../../src/lib/server/csv/values';

describe('formatCell', () => {
	it.each([
		['plain', 'plain'],
		['Smith, Jo', '"Smith, Jo"'],
		['say "hi"', '"say ""hi"""'],
		['two\nlines', '"two\nlines"'],
		['carriage\rreturn', '"carriage\rreturn"'],
		[' padded ', '" padded "'],
		['', '']
	])('formats %j as %j', (value, expected) => {
		expect(formatCell(value)).toBe(expected);
	});

	it.each([
		['=HYPERLINK("x")', `"'=HYPERLINK(""x"")"`],
		['+15550101234', "'+15550101234"],
		['-1', "'-1"],
		['@SUM(A1)', "'@SUM(A1)"],
		['\tleading tab', "'\tleading tab"],
		['\rleading return', `"'\rleading return"`]
	])('guards formula-like value %j', (value, expected) => {
		expect(formatCell(value)).toBe(expected);
	});
});

describe('toCsv', () => {
	it('writes a BOM and CRLF after every record', () => {
		expect(
			toCsv([
				['a', 'b'],
				['1', '2']
			])
		).toBe('\uFEFFa,b\r\n1,2\r\n');
	});

	it('round-trips awkward values through the parser', () => {
		const awkward = [
			'Smith, Jo',
			'O"Brien',
			'"quoted"',
			'multi\r\nline',
			'lone\rcr',
			'lf\nonly',
			'  spaces  ',
			'\ttab',
			'=1+1',
			'+15550101234',
			'-minus',
			'@at',
			'',
			'Zoë, Ñúñez "Jr."',
			"'already apostrophe"
		];
		const header = awkward.map((_, index) => `c${index}`);
		const csv = toCsv([header, awkward, [...awkward].reverse()]);
		const parsed = parseCsv(new TextEncoder().encode(csv));
		if (!parsed.ok) throw new Error(parsed.error.message);
		const unguard = (value: string, original: string) =>
			value === `'${original}` ? original : value;
		const [first, second] = parsed.rows;
		expect(first.fields.map((v, i) => unguard(v, awkward[i]))).toEqual(awkward);
		const reversed = [...awkward].reverse();
		expect(second.fields.map((v, i) => unguard(v, reversed[i]))).toEqual(reversed);
		expect(parsed.rows.every((row) => row.error === undefined)).toBe(true);
	});

	it('keeps a single empty cell as a row', () => {
		const parsed = parseCsv(new TextEncoder().encode(toCsv([['only'], [''], ['x']])));
		if (!parsed.ok) throw new Error(parsed.error.message);
		expect(parsed.rows.map((row) => row.fields)).toEqual([[''], ['x']]);
	});
});

describe('parseBoolean', () => {
	it.each([
		['true', true],
		['TRUE', true],
		[' Yes ', true],
		['1', true],
		['false', false],
		['No', false],
		['0', false]
	])('reads %j as %s', (input, expected) => {
		expect(parseBoolean(input)).toBe(expected);
	});

	it.each(['', 'y', 'on', '2', 'nope'])('rejects %j', (input) => {
		expect(parseBoolean(input)).toBeNull();
	});
});
