import { formatDate } from '$lib/domain/time';
import { isManager, requireUser } from '$lib/server/auth/guard';
import { attempt, parseForm } from '$lib/server/forms';
import { cancelSignupSchema, shiftIdSchema } from '$lib/server/schemas';
import type { RosterEntry } from '$lib/server/services/shifts';
import {
	cancelSignup,
	listUpcoming,
	signUp,
	VOLUNTEER_CANCEL_CUTOFF_MS
} from '$lib/server/services/signups';
import { shiftView, type ShiftView } from '$lib/server/view';
import type { Actions, PageServerLoad } from './$types';

interface DayGroup {
	date: string;
	label: string;
	shifts: (ShiftView & {
		confirmed: number;
		remaining: number;
		full: boolean;
		going: RosterEntry[];
		mine: { signupId: string; status: string; position: number | null } | null;
		canCancel: boolean;
	})[];
}

export const load: PageServerLoad = (event) => {
	const user = requireUser(event);
	const { ctx } = event.locals;
	const now = ctx.now();
	const groups: DayGroup[] = [];
	for (const item of listUpcoming(ctx, user.id)) {
		const view = shiftView(item.shift, ctx.zone);
		let group = groups.at(-1);
		if (!group || group.date !== view.date) {
			group = { date: view.date, label: formatDate(view.date), shifts: [] };
			groups.push(group);
		}
		group.shifts.push({
			...view,
			confirmed: item.confirmed,
			remaining: Math.max(0, item.shift.capacity - item.confirmed),
			full: item.confirmed >= item.shift.capacity,
			going: item.going,
			mine: item.mine,
			canCancel: isManager(user) || now <= item.shift.startsAt - VOLUNTEER_CANCEL_CUTOFF_MS
		});
	}
	return { groups, canRemove: isManager(user) };
};

export const actions: Actions = {
	signup: async (event) => {
		const user = requireUser(event);
		const parsed = await parseForm(event, shiftIdSchema);
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () =>
			signUp(event.locals.ctx, { userId: user.id, shiftId: parsed.data.shiftId, actor: user })
		);
		if (!result.ok) return result.failure;
		if (result.value.status === 'waitlisted') {
			return { notice: 'The shift is full; you are on the waitlist.' };
		}
		return { notice: 'You are signed up.' };
	},
	cancel: async (event) => {
		const user = requireUser(event);
		const parsed = await parseForm(event, cancelSignupSchema);
		if (!parsed.ok) return parsed.failure;
		const { signupId, shiftId } = parsed.data;
		const result = attempt(event, parsed.values, () =>
			cancelSignup(event.locals.ctx, signupId, user, { shiftId })
		);
		if (!result.ok) return result.failure;
		const own = result.value.signup.userId === user.id;
		return { notice: own ? 'Your signup was cancelled.' : 'Volunteer removed.' };
	}
};
