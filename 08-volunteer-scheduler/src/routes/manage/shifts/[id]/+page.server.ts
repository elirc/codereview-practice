import { error } from '@sveltejs/kit';
import { requireManager } from '$lib/server/auth/guard';
import { attempt, parseForm } from '$lib/server/forms';
import { occurrenceEditSchema, oneOffShiftSchema } from '$lib/server/schemas';
import { modifyOccurrence } from '$lib/server/services/series';
import { cancelShift, getShift, getShiftDetail, updateShift } from '$lib/server/services/shifts';
import { shiftView, timestampLabel } from '$lib/server/view';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireManager(event);
	const { ctx } = event.locals;
	const detail = getShiftDetail(ctx, event.params.id);
	if (!detail) error(404, { code: 'not_found', message: 'Shift not found.' });
	const now = ctx.now();
	return {
		shift: shiftView(detail.shift, ctx.zone),
		series: detail.series ? { id: detail.series.id, title: detail.series.title } : null,
		started: detail.shift.startsAt <= now,
		ended: detail.shift.endsAt <= now,
		roster: detail.roster.map((entry) => ({
			...entry,
			signedUpLabel: timestampLabel(entry.createdAt, ctx.zone)
		}))
	};
};

export const actions: Actions = {
	update: async (event) => {
		requireManager(event);
		const { ctx } = event.locals;
		const shift = getShift(ctx.db, event.params.id);
		if (!shift) error(404, { code: 'not_found', message: 'Shift not found.' });
		if (shift.seriesId) {
			const parsed = await parseForm(event, occurrenceEditSchema);
			if (!parsed.ok) return parsed.failure;
			const result = attempt(event, parsed.values, () =>
				modifyOccurrence(ctx, shift.id, parsed.data)
			);
			return result.ok ? { notice: 'Occurrence updated.' } : result.failure;
		}
		const parsed = await parseForm(event, oneOffShiftSchema);
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () => updateShift(ctx, shift.id, parsed.data));
		return result.ok ? { notice: 'Shift updated.' } : result.failure;
	},
	cancel: (event) => {
		requireManager(event);
		const result = attempt(event, {}, () => cancelShift(event.locals.ctx, event.params.id));
		return result.ok ? { notice: 'Shift cancelled.' } : result.failure;
	}
};
