import { z } from 'zod';

export const TEMPLATES = [
	'signup-confirmed',
	'signup-waitlisted',
	'waitlist-promoted',
	'signup-cancelled',
	'shift-cancelled',
	'shift-changed',
	'reminder-24h'
] as const;

export type Template = (typeof TEMPLATES)[number];

export type SignupTemplate =
	| 'signup-confirmed'
	| 'signup-waitlisted'
	| 'waitlist-promoted'
	| 'signup-cancelled';

const id = z.string().min(1);

export const signupPayload = z.object({ signupId: id, shiftId: id });
export const shiftPayload = z.object({ shiftId: id });
export const shiftChangedPayload = z.object({ shiftId: id, startsAt: z.number().int() });

export function isTemplate(value: string): value is Template {
	return (TEMPLATES as readonly string[]).includes(value);
}
