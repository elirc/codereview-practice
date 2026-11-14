<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const notice = $derived(form && 'notice' in form ? form.notice : null);
</script>

<svelte:head>
	<title>My signups · Volunteer Scheduler</title>
</svelte:head>

<h1>My signups</h1>
<p><a href="/my/profile">Profile and notification preferences</a></p>
<FormError {form} />
{#if notice}<p class="notice">{notice}</p>{/if}

<table>
	<thead>
		<tr><th>When</th><th>Shift</th><th>Location</th><th>Status</th><th></th></tr>
	</thead>
	<tbody>
		{#each data.signups as signup (signup.id)}
			<tr>
				<td>{signup.shift.startsLabel}</td>
				<td>{signup.shift.title}</td>
				<td>{signup.shift.location}</td>
				<td>
					{signup.status}
					{#if signup.position}(#{signup.position} on the waitlist){/if}
				</td>
				<td>
					{#if signup.canCancel}
						<form method="POST" action="?/cancel" class="inline" use:enhance>
							<input type="hidden" name="signupId" value={signup.id} />
							<button type="submit">Cancel</button>
						</form>
					{:else}
						<span class="muted">Cancellation closed {signup.cancellableUntil}</span>
					{/if}
				</td>
			</tr>
		{:else}
			<tr><td colspan="5">You have no upcoming signups. <a href="/">Find a shift</a>.</td></tr>
		{/each}
	</tbody>
</table>
