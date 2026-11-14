import { randomUUID } from 'node:crypto';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { getApp } from '$lib/server/app';
import { INTERNAL_ERROR_MESSAGE } from '$lib/server/errors';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const init: ServerInit = () => {
	if (!building) getApp();
};

export const handle: Handle = async ({ event, resolve }) => {
	const app = getApp();
	const inbound = event.request.headers.get('x-request-id');
	const requestId = inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
	event.locals.requestId = requestId;
	event.locals.log = app.logger.child({ requestId });

	const started = performance.now();
	const response = await resolve(event);
	response.headers.set('x-request-id', requestId);
	event.locals.log.info(
		{
			method: event.request.method,
			path: event.url.pathname,
			status: response.status,
			durationMs: Math.round(performance.now() - started)
		},
		'request completed'
	);
	return response;
};

export const handleError: HandleServerError = ({ error, event, status }) => {
	const requestId = event.locals.requestId ?? randomUUID();
	if (status === 404) {
		return { code: 'not_found', message: 'Not found.', requestId };
	}
	(event.locals.log ?? getApp().logger).error({ err: error, requestId }, 'unhandled error');
	return { code: 'internal_error', message: INTERNAL_ERROR_MESSAGE, requestId };
};
