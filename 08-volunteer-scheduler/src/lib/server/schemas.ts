import { z } from 'zod';
import { isCivilDate, isWallTime } from '../domain/dates';
import { normalizePhone } from '../domain/phone';
import { WEEKDAYS, type Weekday } from '../domain/recurrence';
import { EXCEPTION_KINDS, FREQUENCIES, IMPORT_MODES } from './db/schema';
import type { SeriesInput } from './services/series';

const blankToUndefined = (value: unknown) =>
	typeof value === 'string' && value.trim() === '' ? undefined : value;

export const uuidField = z.string().uuid('Invalid id.');
export const civilDateField = z
	.string()
	.trim()
	.refine(isCivilDate, 'Use a valid date (YYYY-MM-DD).');
export const wallTimeField = z.string().trim().refine(isWallTime, 'Use a 24-hour time (HH:MM).');
export const titleField = z.string().trim().min(1, 'Required.').max(120, 'Too long.');
export const locationField = z.string().trim().min(1, 'Required.').max(200, 'Too long.');

export function intField(min: number, max: number) {
	return z.coerce
		.number({ invalid_type_error: 'Must be a number.' })
		.int('Must be a whole number.')
		.min(min, `Must be at least ${min}.`)
		.max(max, `Must be at most ${max}.`);
}

export function optional<T extends z.ZodTypeAny>(schema: T) {
	return z.preprocess(blankToUndefined, schema.optional());
}

export const durationField = intField(15, 720);
export const capacityField = intField(1, 500);

export const oneOffShiftSchema = z.object({
	title: titleField,
	location: locationField,
	date: civilDateField,
	startTime: wallTimeField,
	durationMinutes: durationField,
	capacity: capacityField
});

export const occurrenceEditSchema = z.object({
	location: locationField,
	startTime: wallTimeField,
	durationMinutes: durationField,
	capacity: capacityField
});

const seriesFields = z.object({
	title: titleField,
	location: locationField,
	description: z.string().trim().max(2000, 'Too long.').default(''),
	startTime: wallTimeField,
	durationMinutes: durationField,
	capacity: capacityField,
	freq: z.enum(FREQUENCIES),
	interval: intField(1, 52),
	byWeekday: z.array(z.enum(WEEKDAYS)).default([]),
	byMonthDay: optional(intField(-1, 31)),
	dtstart: civilDateField,
	until: optional(civilDateField),
	count: optional(intField(1, 500))
});

type SeriesFields = z.infer<typeof seriesFields>;

function checkSeries(value: SeriesFields, ctx: z.RefinementCtx): void {
	if (value.until && value.count) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['count'],
			message: 'Use an end date or a count, not both.'
		});
	}
	if (value.until && value.until < value.dtstart) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['until'],
			message: 'The end date must not be before the start date.'
		});
	}
	if (value.freq === 'WEEKLY' && value.byWeekday.length === 0) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['byWeekday'],
			message: 'Choose at least one weekday.'
		});
	}
	if (value.freq === 'MONTHLY' && (value.byMonthDay === undefined || value.byMonthDay === 0)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['byMonthDay'],
			message: 'Choose a day of the month (1–31, or -1 for the last day).'
		});
	}
}

function toSeriesInput(value: SeriesFields): SeriesInput {
	const weekdays: Weekday[] = WEEKDAYS.filter((day) => value.byWeekday.includes(day));
	return {
		title: value.title,
		location: value.location,
		description: value.description,
		startTime: value.startTime,
		durationMinutes: value.durationMinutes,
		capacity: value.capacity,
		freq: value.freq,
		interval: value.interval,
		byWeekday: value.freq === 'WEEKLY' ? weekdays : null,
		byMonthDay: value.freq === 'MONTHLY' ? (value.byMonthDay ?? null) : null,
		dtstart: value.dtstart,
		until: value.until ?? null,
		count: value.count ?? null
	};
}

export const seriesSchema = seriesFields.superRefine(checkSeries).transform(toSeriesInput);

export const seriesEditSchema = seriesFields
	.extend({ effectiveFrom: civilDateField })
	.superRefine(checkSeries)
	.transform((value) => ({ series: toSeriesInput(value), effectiveFrom: value.effectiveFrom }));

export const exceptionSchema = z.object({
	occurrenceDate: civilDateField,
	kind: z.enum(EXCEPTION_KINDS),
	startTime: optional(wallTimeField),
	durationMinutes: optional(durationField),
	capacity: optional(capacityField),
	location: optional(locationField)
});

export const shiftFilterSchema = z.object({
	from: optional(civilDateField),
	to: optional(civilDateField),
	status: optional(z.enum(['scheduled', 'cancelled'])),
	q: optional(z.string().trim().max(100))
});

export const shiftIdSchema = z.object({ shiftId: uuidField });
export const signupIdSchema = z.object({ signupId: uuidField });
export const emailField = z.string().trim().toLowerCase().email('Enter a valid email address.');
export const rosterAddSchema = z.object({ email: emailField });

export const attendanceSchema = z.object({
	signupId: uuidField,
	attended: z.enum(['true', 'false']).transform((value) => value === 'true')
});

const checkbox = z.preprocess((value) => value === 'on' || value === 'true', z.boolean());

export const phoneField = z
	.string()
	.trim()
	.max(40, 'Too long.')
	.transform((value, ctx) => {
		if (value === '') return null;
		const phone = normalizePhone(value);
		if (!phone) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid phone number.' });
			return z.NEVER;
		}
		return phone;
	});

export const profileSchema = z.object({
	name: z.string().trim().min(1, 'Required.').max(120, 'Too long.'),
	phone: phoneField.default(''),
	emailOptIn: checkbox,
	smsOptIn: checkbox
});

export const importModeSchema = z.object({ mode: z.enum(IMPORT_MODES) });

export const exportRangeSchema = z
	.object({ from: civilDateField, to: civilDateField })
	.refine((value) => value.to >= value.from, {
		message: 'The end date must not be before the start date.',
		path: ['to']
	});
