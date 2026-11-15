import { orgDate } from '../../domain/time';
import type { AppContext } from '../context';
import { IMMEDIATE } from '../db/client';
import { shiftSeries } from '../db/schema';
import { materializeSeries } from '../services/series';

/** Tops up every series to the horizon; one failing series does not stop the rest. */
export function materializeJob(ctx: AppContext): void {
	const now = ctx.now();
	const today = orgDate(now, ctx.zone);
	const all = ctx.db.select().from(shiftSeries).all();
	let failed = 0;
	let inserted = 0;
	let ended = 0;
	for (const series of all) {
		if (series.until !== null && series.until < today) {
			ended += 1;
			continue;
		}
		try {
			inserted += ctx.db.transaction(
				(tx) => materializeSeries(tx, now, ctx.zone, series),
				IMMEDIATE
			);
		} catch (err) {
			failed += 1;
			ctx.logger.error({ err, seriesId: series.id }, 'series materialisation failed');
		}
	}
	ctx.logger.info({ series: all.length, ended, inserted, failed }, 'materialisation finished');
	if (failed > 0) throw new Error(`${failed} of ${all.length} series failed to materialise.`);
}
