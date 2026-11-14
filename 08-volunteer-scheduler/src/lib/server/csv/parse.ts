export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 5000;

export interface CsvRowError {
	code: 'malformed_quotes';
	message: string;
}

export interface CsvRecord {
	/** 1-based index among data records; the header is 0. */
	rowNumber: number;
	/** Physical line on which the record starts. */
	line: number;
	fields: string[];
	error?: CsvRowError;
}

export type CsvFileErrorCode =
	| 'file_too_large'
	| 'too_many_rows'
	| 'invalid_encoding'
	| 'unterminated_quote'
	| 'missing_header'
	| 'malformed_header';

export interface CsvFileError {
	code: CsvFileErrorCode;
	message: string;
	line?: number;
}

export type CsvParseResult =
	| { ok: true; header: CsvRecord; rows: CsvRecord[] }
	| { ok: false; error: CsvFileError };

interface RawRecord {
	line: number;
	fields: string[];
	error?: CsvRowError;
}

class UnterminatedQuote extends Error {
	constructor(readonly line: number) {
		super(`A quoted field starting on line ${line} is never closed.`);
	}
}

function isBlank(char: string | undefined): boolean {
	return char === ' ' || char === '\t';
}

function trimBlanks(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && isBlank(value[start])) start++;
	while (end > start && isBlank(value[end - 1])) end--;
	return value.slice(start, end);
}

/** Splits text into records, tracking the physical line each record starts on. */
function tokenize(text: string): RawRecord[] {
	const records: RawRecord[] = [];
	const length = text.length;
	let i = 0;
	let line = 1;

	const atRecordEnd = () => i >= length || text[i] === '\r' || text[i] === '\n';
	const consumeNewline = () => {
		if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
		else i += 1;
		line += 1;
	};

	while (i < length) {
		if (text[i] === '\r' || text[i] === '\n') {
			consumeNewline();
			continue;
		}
		const record: RawRecord = { line, fields: [] };
		for (;;) {
			let start = i;
			while (isBlank(text[start])) start++;
			if (text[start] === '"') {
				const openedOn = line;
				let value = '';
				let j = start + 1;
				let closed = false;
				while (j < length) {
					const char = text[j];
					if (char === '"') {
						if (text[j + 1] === '"') {
							value += '"';
							j += 2;
							continue;
						}
						closed = true;
						j += 1;
						break;
					}
					if (char === '\r' || char === '\n') {
						const newline = char === '\r' && text[j + 1] === '\n' ? '\r\n' : char;
						value += newline;
						j += newline.length;
						line += 1;
						continue;
					}
					value += char;
					j += 1;
				}
				if (!closed) throw new UnterminatedQuote(openedOn);
				record.fields.push(value);
				i = j;
				if (atRecordEnd()) break;
				if (text[i] === ',') {
					i += 1;
					continue;
				}
				record.error = {
					code: 'malformed_quotes',
					message: `Unexpected text after the closing quote of field ${record.fields.length}.`
				};
				while (!atRecordEnd()) i += 1;
				break;
			}
			let end = i;
			while (end < length && text[end] !== ',' && text[end] !== '\r' && text[end] !== '\n') end++;
			record.fields.push(trimBlanks(text.slice(i, end)));
			i = end;
			if (i < length && text[i] === ',') {
				i += 1;
				continue;
			}
			break;
		}
		records.push(record);
		if (i < length) consumeNewline();
	}
	return records;
}

function fileError(code: CsvFileErrorCode, message: string, line?: number): CsvParseResult {
	return { ok: false, error: { code, message, line } };
}

/** Parses already-decoded CSV text. */
export function parseCsvText(input: string): CsvParseResult {
	const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
	let records: RawRecord[];
	try {
		records = tokenize(text);
	} catch (err) {
		if (err instanceof UnterminatedQuote) {
			return fileError('unterminated_quote', err.message, err.line);
		}
		throw err;
	}
	const [header, ...data] = records;
	if (!header) return fileError('missing_header', 'The file is empty; a header row is required.');
	if (header.error) {
		return fileError('malformed_header', 'The header row has malformed quotes.', header.line);
	}
	if (data.length > MAX_CSV_ROWS) {
		return fileError('too_many_rows', `The file has more than ${MAX_CSV_ROWS} data rows.`);
	}
	return {
		ok: true,
		header: { ...header, rowNumber: 0 },
		rows: data.map((record, index) => ({ ...record, rowNumber: index + 1 }))
	};
}

/** Decodes and parses an uploaded CSV file (UTF-8, optional BOM). */
export function parseCsv(bytes: Uint8Array): CsvParseResult {
	if (bytes.byteLength > MAX_CSV_BYTES) {
		return fileError('file_too_large', 'The file is larger than 2 MiB.');
	}
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return fileError('invalid_encoding', 'The file is not valid UTF-8.');
	}
	return parseCsvText(text);
}
