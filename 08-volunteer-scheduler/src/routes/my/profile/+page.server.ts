import { requireUser } from '$lib/server/auth/guard';
import { attempt, parseForm } from '$lib/server/forms';
import { profileSchema } from '$lib/server/schemas';
import { updateProfile } from '$lib/server/services/users';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	const user = requireUser(event);
	return {
		profile: {
			name: user.name,
			email: user.email,
			phone: user.phone ?? '',
			emailOptIn: user.emailOptIn,
			smsOptIn: user.smsOptIn
		}
	};
};

export const actions: Actions = {
	default: async (event) => {
		const user = requireUser(event);
		const parsed = await parseForm(event, profileSchema);
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () =>
			updateProfile(event.locals.ctx, user.id, parsed.data)
		);
		return result.ok ? { notice: 'Profile saved.' } : result.failure;
	}
};
