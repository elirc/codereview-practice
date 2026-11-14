const PHONE_CHARACTERS = /^\+?[\d\s().-]+$/;

/**
 * Normalises a phone number to E.164. Ten digits are taken as a North
 * American number; eleven digits starting with 1 already include the
 * country code; numbers written with a leading `+` keep their country code.
 * Returns null for anything else.
 */
export function normalizePhone(input: string): string | null {
	const trimmed = input.trim();
	if (!PHONE_CHARACTERS.test(trimmed)) return null;
	const digits = trimmed.replace(/\D/g, '');
	if (trimmed.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
	if (digits.length === 10) return `+1${digits}`;
	if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
	return null;
}
