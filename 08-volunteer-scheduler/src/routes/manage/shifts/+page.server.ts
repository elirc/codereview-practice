import { redirect } from '@sveltejs/kit';
import { requireManager } from '$lib/server/auth/guard';
import { attempt, parseForm } from '$lib/server/forms';
import { oneOffShiftSchema, shiftFilterSchema } from '$lib/server/schemas';
import { horizon } from '$lib/server/services/series';
import { createShift, listShifts } from '$lib/server/services/shifts';
import { shiftView } from '$lib/server/view';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireManager(event);
	const { ctx } = event.locals;
	const { today, end } = horizon(ctx.now(), ctx.zone);
	const parsed = shiftFilterSchema.safeParse(Object.fromEntries(event.url.searchParams));
	const filter = parsed.success ? parsed.data : {};
	const from = filter.from ?? today;
	const to = filter.to && filter.to >= from ? filter.to : end;
	const items = listShifts(ctx, { from, to, status: filter.status, q: filter.q });
	return {
		filter: { from, to, status: filter.status ?? '', q: filter.q ?? '' },
		today,
		shifts: items.map((item) => ({
			...shiftView(item.shift, ctx.zone),
			confirmed: item.confirmed,
			waitlisted: item.waitlisted
		}))
	};
};

export const actions: Actions = {
	create: async (event) => {
		requireManager(event);
		const parsed = await parseForm(event, oneOffShiftSchema);
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () => createShift(event.locals.ctx, parsed.data));
		if (!result.ok) return result.failure;
		redirect(303, `/manage/shifts/${result.value.id}`);
	}
};
