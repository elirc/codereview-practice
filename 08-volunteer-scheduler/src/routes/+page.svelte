<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const notice = $derived(form && 'notice' in form ? form.notice : null);

	function firstName(name: string): string {
		return name.trim().split(/\s+/)[0] ?? name;
	}
</script>

<svelte:head>
	<title>Upcoming shifts · Volunteer Scheduler</title>
</svelte:head>

<h1>Upcoming shifts</h1>
<FormError {form} />
{#if notice}<p class="notice">{notice}</p>{/if}

{#each data.groups as group (group.date)}
	<h2>{group.label}</h2>
	<table>
		<thead>
			<tr>
				<th>Time</th><th>Shift</th><th>Location</th><th>Spots left</th><th>Going</th><th>You</th>
			</tr>
		</thead>
		<tbody>
			{#each group.shifts as shift (shift.id)}
				<tr>
					<td>
						{shift.startTime}–{shift.endTime}
						{#if shift.endDate !== shift.date}<span class="muted">(next day)</span>{/if}
					</td>
					<td>{shift.title}</td>
					<td>{shift.location}</td>
					<td>{shift.full ? 'full (waitlist open)' : `${shift.remaining} of ${shift.capacity}`}</td>
					<td>
						{#if shift.going.length === 0}
							<span class="muted">nobody yet</span>
						{:else}
							<ul class="going">
								{#each shift.going as person (person.signupId)}
									<li>
										{firstName(person.name)}
										{#if data.canRemove}
											<form method="POST" action="?/cancel" class="inline" use:enhance>
												<input type="hidden" name="signupId" value={person.signupId} />
												<input type="hidden" name="shiftId" value={shift.id} />
												<button type="submit" class="link">Remove</button>
											</form>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</td>
					<td>
						{#if shift.mine}
							{shift.mine.status}
							{#if shift.mine.position}(#{shift.mine.position} on the waitlist){/if}
							{#if shift.canCancel}
								<form method="POST" action="?/cancel" class="inline" use:enhance>
									<input type="hidden" name="signupId" value={shift.mine.signupId} />
									<button type="submit">Cancel</button>
								</form>
							{/if}
						{:else}
							<form method="POST" action="?/signup" class="inline" use:enhance>
								<input type="hidden" name="shiftId" value={shift.id} />
								<button type="submit">{shift.full ? 'Join waitlist' : 'Sign up'}</button>
							</form>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{:else}
	<p>No shifts are scheduled in the next 60 days.</p>
{/each}
