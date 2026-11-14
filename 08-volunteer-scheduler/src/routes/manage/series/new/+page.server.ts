import { redirect } from '@sveltejs/kit';
import { requireManager } from '$lib/server/auth/guard';
import { attempt, parseForm } from '$lib/server/forms';
import { seriesSchema } from '$lib/server/schemas';
import { createSeries, horizon } from '$lib/server/services/series';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireManager(event);
	const { ctx } = event.locals;
	return { today: horizon(ctx.now(), ctx.zone).today };
};

export const actions: Actions = {
	default: async (event) => {
		requireManager(event);
		const parsed = await parseForm(event, seriesSchema, ['byWeekday']);
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () => createSeries(event.locals.ctx, parsed.data));
		if (!result.ok) return result.failure;
		redirect(303, `/manage/series/${result.value.id}`);
	}
};
