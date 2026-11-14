import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { DomainError } from '$lib/server/errors';
import { handleEndpoint } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	handleEndpoint(event, () => {
		try {
			event.locals.ctx.db.get(sql`select 1`);
		} catch (err) {
			event.locals.log.error({ err }, 'health check query failed');
			throw new DomainError('unavailable', 503, 'Database is unavailable.');
		}
		return json({ status: 'ok', time: new Date(event.locals.ctx.now()).toISOString() });
	});
