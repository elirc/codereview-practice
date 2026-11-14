import { shiftSeries } from '../db/schema';
import type { AppContext } from '../context';
import { materializeSeriesById } from '../services/series';

/** Tops up every series to the horizon; one failing series does not stop the rest. */
export function materializeJob(ctx: AppContext): void {
	const all = ctx.db.select({ id: shiftSeries.id }).from(shiftSeries).all();
	let failed = 0;
	let inserted = 0;
	for (const { id } of all) {
		try {
			inserted += materializeSeriesById(ctx, id);
		} catch (err) {
			failed += 1;
			ctx.logger.error({ err, seriesId: id }, 'series materialisation failed');
		}
	}
	ctx.logger.info({ series: all.length, inserted, failed }, 'materialisation finished');
	if (failed > 0) throw new Error(`${failed} of ${all.length} series failed to materialise.`);
}
