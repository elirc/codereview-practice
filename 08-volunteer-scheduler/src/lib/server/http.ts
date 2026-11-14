import { isHttpError, isRedirect, json, type RequestEvent } from '@sveltejs/kit';
import { DomainError, errorEnvelope, INTERNAL_ERROR_MESSAGE } from './errors';

/** Wraps a `+server.ts` handler so every failure leaves as the JSON error envelope. */
export async function handleEndpoint(
	event: RequestEvent,
	handler: () => Response | Promise<Response>
): Promise<Response> {
	const requestId = event.locals.requestId;
	try {
		return await handler();
	} catch (err) {
		if (isRedirect(err)) throw err;
		if (err instanceof DomainError) {
			return json(
				errorEnvelope({ code: err.code, message: err.message, details: err.details, requestId }),
				{ status: err.status }
			);
		}
		if (isHttpError(err)) {
			return json(errorEnvelope({ code: err.body.code, message: err.body.message, requestId }), {
				status: err.status
			});
		}
		event.locals.log.error({ err }, 'endpoint failed');
		return json(
			errorEnvelope({ code: 'internal_error', message: INTERNAL_ERROR_MESSAGE, requestId }),
			{ status: 500 }
		);
	}
}

export function csvResponse(filename: string, body: string): Response {
	return new Response(body, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
			'cache-control': 'no-store'
		}
	});
}
