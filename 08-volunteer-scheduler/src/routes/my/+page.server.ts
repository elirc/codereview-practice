import { isManager, requireUser } from '$lib/server/auth/guard';
import { attempt, parseForm } from '$lib/server/forms';
import { signupIdSchema } from '$lib/server/schemas';
import { cancelSignup, listMySignups } from '$lib/server/services/signups';
import { shiftView, timestampLabel } from '$lib/server/view';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	const user = requireUser(event);
	const { ctx } = event.locals;
	const now = ctx.now();
	return {
		signups: listMySignups(ctx, user.id).map((item) => ({
			id: item.signup.id,
			status: item.signup.status,
			position: item.position,
			shift: shiftView(item.shift, ctx.zone),
			canCancel: isManager(user) ? now < item.shift.endsAt : now <= item.cancellableUntil,
			cancellableUntil: timestampLabel(item.cancellableUntil, ctx.zone)
		}))
	};
};

export const actions: Actions = {
	cancel: async (event) => {
		const user = requireUser(event);
		const parsed = await parseForm(event, signupIdSchema);
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () =>
			cancelSignup(event.locals.ctx, parsed.data.signupId, user)
		);
		return result.ok ? { notice: 'Your signup was cancelled.' } : result.failure;
	}
};
