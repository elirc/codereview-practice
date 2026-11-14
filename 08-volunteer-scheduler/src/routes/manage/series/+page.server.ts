import { requireManager } from '$lib/server/auth/guard';
import { listSeries } from '$lib/server/services/series';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireManager(event);
	return {
		series: listSeries(event.locals.ctx).map(({ series, upcoming }) => ({
			id: series.id,
			title: series.title,
			location: series.location,
			freq: series.freq,
			interval: series.interval,
			startTime: series.startTime,
			dtstart: series.dtstart,
			until: series.until,
			count: series.count,
			upcoming
		}))
	};
};
