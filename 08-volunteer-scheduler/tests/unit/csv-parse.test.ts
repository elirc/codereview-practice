import { describe, expect, it } from 'vitest';
import {
	MAX_CSV_BYTES,
	MAX_CSV_ROWS,
	parseCsv,
	parseCsvText,
	type CsvParseResult
} from '../../src/lib/server/csv/parse';

const encoder = new TextEncoder();

function ok(result: CsvParseResult) {
	if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
	return result;
}

function fail(result: CsvParseResult) {
	if (result.ok) throw new Error('expected a file-level error');
	return result.error;
}

describe('parseCsv', () => {
	it('handles a BOM, CRLF, and quoted commas, newlines and doubled quotes', () => {
		const text =
			'\uFEFFname,email,notes\r\n' +
			'"Smith, Jo",jo@example.org,"line one\r\nline two ""quoted"""\r\n' +
			'Ann,ann@example.org,plain\r\n';
		const result = ok(parseCsv(encoder.encode(text)));
		expect(result.header.fields).toEqual(['name', 'email', 'notes']);
		expect(result.rows).toEqual([
			{
				rowNumber: 1,
				line: 2,
				fields: ['Smith, Jo', 'jo@example.org', 'line one\r\nline two "quoted"']
			},
			{ rowNumber: 2, line: 4, fields: ['Ann', 'ann@example.org', 'plain'] }
		]);
	});

	it('accepts LF and lone CR separators and a final record without a newline', () => {
		const result = ok(parseCsvText('a,b\nc,d\re,f'));
		expect(result.rows.map((r) => [r.line, ...r.fields])).toEqual([
			[2, 'c', 'd'],
			[3, 'e', 'f']
		]);
	});

	it('skips blank lines without counting them as rows but keeps line numbers', () => {
		const result = ok(parseCsvText('a,b\n\nc,d\r\n\r\n\ne,f\n\n'));
		expect(result.rows.map((r) => [r.rowNumber, r.line, r.fields[0]])).toEqual([
			[1, 3, 'c'],
			[2, 6, 'e']
		]);
	});

	it('trims unquoted fields but keeps quoted ones verbatim', () => {
		const result = ok(parseCsvText('a,b,c\n  x\t, " y " ,"\tz"\n'));
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].error?.code).toBe('malformed_quotes');
		const clean = ok(parseCsvText('a,b,c\n  x\t, " y ","\tz"\n'));
		expect(clean.rows[0].fields).toEqual(['x', ' y ', '\tz']);
	});

	it('keeps empty fields, including a trailing one', () => {
		const result = ok(parseCsvText('a,b,c\n,,\nx,"",'));
		expect(result.rows.map((r) => r.fields)).toEqual([
			['', '', ''],
			['x', '', '']
		]);
	});

	it('reports text after a closing quote as a row error and carries on', () => {
		const result = ok(parseCsvText('a,b\n"abc"def,x\nok,row\n'));
		expect(result.rows[0]).toMatchObject({
			rowNumber: 1,
			line: 2,
			error: { code: 'malformed_quotes' }
		});
		expect(result.rows[1]).toMatchObject({ rowNumber: 2, line: 3, fields: ['ok', 'row'] });
	});

	it('names the line where an unterminated quote opened', () => {
		const error = fail(parseCsvText('a,b\nx,y\nz,"never\nclosed,\n'));
		expect(error).toMatchObject({ code: 'unterminated_quote', line: 3 });
	});

	it('returns zero rows for a header-only file', () => {
		const result = ok(parseCsvText('name,email\r\n'));
		expect(result.rows).toEqual([]);
	});

	it('reports a missing header for an empty file', () => {
		expect(fail(parseCsv(new Uint8Array())).code).toBe('missing_header');
		expect(fail(parseCsvText('\uFEFF\r\n\n')).code).toBe('missing_header');
	});

	it('rejects invalid UTF-8', () => {
		const bytes = new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xc3, 0x28]);
		expect(fail(parseCsv(bytes)).code).toBe('invalid_encoding');
	});

	it('decodes multi-byte characters', () => {
		const result = ok(parseCsv(encoder.encode('name\nZoë Ñúñez\n')));
		expect(result.rows[0].fields).toEqual(['Zoë Ñúñez']);
	});

	it('enforces the size and row limits', () => {
		expect(fail(parseCsv(new Uint8Array(MAX_CSV_BYTES + 1))).code).toBe('file_too_large');
		const atLimit = `name\n${'x\n'.repeat(MAX_CSV_ROWS)}`;
		expect(ok(parseCsvText(atLimit)).rows).toHaveLength(MAX_CSV_ROWS);
		const overLimit = `name\n${'x\n'.repeat(MAX_CSV_ROWS + 1)}`;
		expect(fail(parseCsvText(overLimit)).code).toBe('too_many_rows');
	});

	it('rejects a header with malformed quotes', () => {
		expect(fail(parseCsvText('"name"x,email\n')).code).toBe('malformed_header');
	});
});
