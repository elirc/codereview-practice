import { requireManager } from '$lib/server/auth/guard';
import { notFound } from '$lib/server/errors';
import { csvResponse, handleEndpoint } from '$lib/server/http';
import { uuidField } from '$lib/server/schemas';
import { rosterCsv } from '$lib/server/services/exports';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	handleEndpoint(event, () => {
		requireManager(event);
		const id = uuidField.safeParse(event.params.id);
		if (!id.success) throw notFound('Shift not found.');
		const file = rosterCsv(event.locals.ctx, id.data);
		return csvResponse(file.filename, file.body);
	});
