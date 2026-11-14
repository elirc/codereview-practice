const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);
const NEEDS_QUOTES = /[",\r\n]/;
const EDGE_BLANKS = /^[ \t]|[ \t]$/;

/**
 * Formats one cell. Values that a spreadsheet would treat as a formula get a
 * leading apostrophe; quoting also covers leading or trailing blanks, which
 * the parser would otherwise trim from an unquoted field.
 */
export function formatCell(value: string): string {
	const guarded = FORMULA_TRIGGERS.has(value.charAt(0)) ? `'${value}` : value;
	if (NEEDS_QUOTES.test(guarded) || EDGE_BLANKS.test(guarded)) {
		return `"${guarded.replace(/"/g, '""')}"`;
	}
	return guarded;
}

function formatRow(row: readonly string[]): string {
	// A lone empty cell would otherwise be an empty line, which readers skip.
	if (row.length === 1 && row[0] === '') return '""';
	return row.map(formatCell).join(',');
}

/** UTF-8 CSV with a byte-order mark and CRLF record endings. */
export function toCsv(rows: readonly (readonly string[])[]): string {
	return `\uFEFF${rows.map((row) => `${formatRow(row)}\r\n`).join('')}`;
}
