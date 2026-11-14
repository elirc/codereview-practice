import { requireManager } from '$lib/server/auth/guard';
import { validationError } from '$lib/server/errors';
import { csvResponse, handleEndpoint } from '$lib/server/http';
import { exportRangeSchema } from '$lib/server/schemas';
import { signupsCsv } from '$lib/server/services/exports';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	handleEndpoint(event, () => {
		requireManager(event);
		const range = exportRangeSchema.safeParse({
			from: event.url.searchParams.get('from') ?? '',
			to: event.url.searchParams.get('to') ?? ''
		});
		if (!range.success) throw validationError(range.error);
		const file = signupsCsv(event.locals.ctx, range.data.from, range.data.to);
		return csvResponse(file.filename, file.body);
	});
