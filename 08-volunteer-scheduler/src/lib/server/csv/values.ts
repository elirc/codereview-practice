const TRUE_VALUES = new Set(['true', 'yes', '1']);
const FALSE_VALUES = new Set(['false', 'no', '0']);

/** Parses `true/false/yes/no/1/0` in any case; null for anything else. */
export function parseBoolean(input: string): boolean | null {
	const value = input.trim().toLowerCase();
	if (TRUE_VALUES.has(value)) return true;
	if (FALSE_VALUES.has(value)) return false;
	return null;
}
