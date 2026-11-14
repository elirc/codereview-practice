import { valuesOf } from './forms';

export interface SeriesFormValues {
	title: string;
	location: string;
	description: string;
	startTime: string;
	durationMinutes: string;
	capacity: string;
	freq: string;
	interval: string;
	byWeekday: string[];
	byMonthDay: string;
	dtstart: string;
	until: string;
	count: string;
}

export interface SeriesLike {
	title: string;
	location: string;
	description: string;
	startTime: string;
	durationMinutes: number;
	capacity: number;
	freq: string;
	interval: number;
	byWeekday: string[] | null;
	byMonthDay: number | null;
	dtstart: string;
	until: string | null;
	count: number | null;
}

function text(value: string | number | null | undefined): string {
	return value === null || value === undefined ? '' : String(value);
}

/** Form values for the series editor: submitted values win over stored ones. */
export function seriesFormValues(
	series: SeriesLike | null,
	form: unknown,
	today: string
): SeriesFormValues {
	const base: SeriesFormValues = series
		? {
				title: series.title,
				location: series.location,
				description: series.description,
				startTime: series.startTime,
				durationMinutes: text(series.durationMinutes),
				capacity: text(series.capacity),
				freq: series.freq,
				interval: text(series.interval),
				byWeekday: series.byWeekday ?? [],
				byMonthDay: text(series.byMonthDay),
				dtstart: series.dtstart,
				until: text(series.until),
				count: text(series.count)
			}
		: {
				title: '',
				location: '',
				description: '',
				startTime: '09:00',
				durationMinutes: '120',
				capacity: '5',
				freq: 'WEEKLY',
				interval: '1',
				byWeekday: [],
				byMonthDay: '',
				dtstart: today,
				until: '',
				count: ''
			};
	const submitted = valuesOf(form);
	const merged = { ...base };
	for (const key of Object.keys(base) as (keyof SeriesFormValues)[]) {
		const value = submitted[key];
		if (value === undefined) continue;
		if (key === 'byWeekday') merged.byWeekday = Array.isArray(value) ? value : [value];
		else merged[key] = Array.isArray(value) ? (value[0] ?? '') : value;
	}
	return merged;
}
