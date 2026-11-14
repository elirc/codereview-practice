import { error, redirect } from '@sveltejs/kit';
import { requireManager } from '$lib/server/auth/guard';
import { attempt, parseForm } from '$lib/server/forms';
import { exceptionSchema, seriesEditSchema } from '$lib/server/schemas';
import {
	deleteSeries,
	getSeriesDetail,
	horizon,
	parseWeekdays,
	setException,
	updateSeries
} from '$lib/server/services/series';
import { shiftView } from '$lib/server/view';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireManager(event);
	const { ctx } = event.locals;
	const detail = getSeriesDetail(ctx, event.params.id);
	if (!detail) error(404, { code: 'not_found', message: 'Series not found.' });
	const { today, end } = horizon(ctx.now(), ctx.zone);
	const { series } = detail;
	return {
		today,
		horizonEnd: end,
		series: {
			id: series.id,
			title: series.title,
			location: series.location,
			description: series.description,
			startTime: series.startTime,
			durationMinutes: series.durationMinutes,
			capacity: series.capacity,
			freq: series.freq,
			interval: series.interval,
			byWeekday: parseWeekdays(series.byWeekday),
			byMonthDay: series.byMonthDay,
			dtstart: series.dtstart,
			until: series.until,
			count: series.count,
			materializedThrough: series.materializedThrough
		},
		exceptions: detail.exceptions.map((exception) => ({
			id: exception.id,
			occurrenceDate: exception.occurrenceDate,
			kind: exception.kind,
			startTime: exception.startTime,
			durationMinutes: exception.durationMinutes,
			capacity: exception.capacity,
			location: exception.location
		})),
		upcoming: detail.upcoming.map((shift) => shiftView(shift, ctx.zone))
	};
};

export const actions: Actions = {
	update: async (event) => {
		requireManager(event);
		const parsed = await parseForm(event, seriesEditSchema, ['byWeekday']);
		if (!parsed.ok) return parsed.failure;
		const { series, effectiveFrom } = parsed.data;
		const result = attempt(event, parsed.values, () =>
			updateSeries(event.locals.ctx, event.params.id, series, effectiveFrom)
		);
		return result.ok ? { notice: `Series updated from ${effectiveFrom}.` } : result.failure;
	},
	exception: async (event) => {
		requireManager(event);
		const parsed = await parseForm(event, exceptionSchema);
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () =>
			setException(event.locals.ctx, event.params.id, parsed.data)
		);
		if (!result.ok) return result.failure;
		const verb = parsed.data.kind === 'cancelled' ? 'cancelled' : 'modified';
		return { notice: `Occurrence on ${parsed.data.occurrenceDate} ${verb}.` };
	},
	delete: (event) => {
		requireManager(event);
		const result = attempt(event, {}, () => deleteSeries(event.locals.ctx, event.params.id));
		if (!result.ok) return result.failure;
		redirect(303, '/manage/series');
	}
};
