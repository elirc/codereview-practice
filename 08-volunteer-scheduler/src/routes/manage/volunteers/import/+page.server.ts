import { requireManager } from '$lib/server/auth/guard';
import { MAX_CSV_BYTES } from '$lib/server/csv/parse';
import { DomainError } from '$lib/server/errors';
import { attempt, parseFormData } from '$lib/server/forms';
import { importModeSchema } from '$lib/server/schemas';
import { importVolunteers } from '$lib/server/services/import';
import type { Actions, PageServerLoad } from './$types';

const CSV_TYPES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel']);

function checkUpload(file: FormDataEntryValue | null): File {
	if (!(file instanceof File) || file.size === 0) {
		throw new DomainError('validation_failed', 400, 'Choose a CSV file to upload.', {
			fields: [{ path: 'file', message: 'Required.' }]
		});
	}
	if (file.size > MAX_CSV_BYTES) {
		throw new DomainError('file_too_large', 413, 'The file is larger than 2 MiB.');
	}
	if (!file.name.toLowerCase().endsWith('.csv') && !CSV_TYPES.has(file.type)) {
		throw new DomainError('unsupported_media_type', 415, 'Upload a .csv file.');
	}
	return file;
}

export const load: PageServerLoad = (event) => {
	requireManager(event);
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		const actor = requireManager(event);
		const form = await event.request.formData();
		const parsed = parseFormData(event, form, importModeSchema);
		if (!parsed.ok) return parsed.failure;
		const checked = attempt(event, parsed.values, () => checkUpload(form.get('file')));
		if (!checked.ok) return checked.failure;
		const upload = checked.value;
		const bytes = new Uint8Array(await upload.arrayBuffer());
		const imported = attempt(event, parsed.values, () =>
			importVolunteers(event.locals.ctx, {
				actorId: actor.id,
				filename: upload.name,
				mode: parsed.data.mode,
				bytes
			})
		);
		if (!imported.ok) return imported.failure;
		const { invites, ...report } = imported.value;
		event.locals.log.info(
			{ runId: report.runId, mode: report.mode, created: report.created, failed: report.failed },
			'volunteer import finished'
		);
		return {
			report: {
				...report,
				invites: invites.map((invite) => ({
					rowNumber: invite.rowNumber,
					name: invite.name,
					email: invite.email,
					url: `${event.url.origin}/invite/${invite.token}`
				}))
			}
		};
	}
};
