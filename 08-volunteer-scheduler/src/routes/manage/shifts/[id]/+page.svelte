<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import { valueOr } from '$lib/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const shift = $derived(data.shift);
	const notice = $derived(form && 'notice' in form ? form.notice : null);
	const confirmed = $derived(data.roster.filter((entry) => entry.status === 'confirmed'));
	const waitlisted = $derived(data.roster.filter((entry) => entry.status === 'waitlisted'));
	const editable = $derived(shift.status === 'scheduled' && !data.started);
</script>

<svelte:head>
	<title>{shift.title} · Volunteer Scheduler</title>
</svelte:head>

<p><a href="/manage/shifts">← All shifts</a></p>
<h1>{shift.title}</h1>
<p>
	{shift.startsLabel} for {shift.durationMinutes} minutes at {shift.location}.
	Status: <strong>{shift.status}</strong>.
	{#if data.series}
		Part of series <a href="/manage/series/{data.series.id}">{data.series.title}</a>
		({shift.occurrenceDate}{shift.detached ? ', modified' : ''}).
	{/if}
</p>
<p>
	Confirmed {confirmed.length} of {shift.capacity}
	{#if confirmed.length > shift.capacity}<strong>— over capacity, not taking signups</strong>{/if}
	· waitlisted {waitlisted.length}
</p>

<FormError {form} />
{#if notice}<p class="notice">{notice}</p>{/if}

{#if editable}
	<h2>Edit</h2>
	<form method="POST" action="?/update" use:enhance>
		{#if !data.series}
			<label>
				Title
				<input name="title" required value={valueOr(form, 'title', shift.title)} />
			</label>
			<label>
				Date
				<input type="date" name="date" required value={valueOr(form, 'date', shift.date)} />
			</label>
		{/if}
		<label>
			Location
			<input name="location" required value={valueOr(form, 'location', shift.location)} />
		</label>
		<label>
			Start time
			<input
				type="time"
				name="startTime"
				required
				value={valueOr(form, 'startTime', shift.startTime)}
			/>
		</label>
		<label>
			Duration (minutes)
			<input
				type="number"
				name="durationMinutes"
				min="15"
				max="720"
				required
				value={valueOr(form, 'durationMinutes', shift.durationMinutes)}
			/>
		</label>
		<label>
			Capacity
			<input
				type="number"
				name="capacity"
				min="1"
				max="500"
				required
				value={valueOr(form, 'capacity', shift.capacity)}
			/>
		</label>
		<button type="submit">Save changes</button>
	</form>

	<form method="POST" action="?/cancel" use:enhance>
		<button type="submit">Cancel this shift</button>
		<span class="muted">Everyone signed up is notified.</span>
	</form>
{/if}

<h2>Roster</h2>
<p><a href="/shifts/{shift.id}/roster.csv" download>Download roster (CSV)</a></p>
{#if !data.ended && shift.status === 'scheduled'}
	<form method="POST" action="?/add" use:enhance>
		<label class="check">
			Add volunteer by email
			<input name="email" type="email" required value={valueOr(form, 'email', '')} />
		</label>
		<button type="submit">Add</button>
	</form>
{/if}
<table>
	<thead>
		<tr>
			<th>Name</th>
			<th>Email</th>
			<th>Phone</th>
			<th>Status</th>
			<th>Signed up</th>
			<th>Attended</th>
			<th></th>
		</tr>
	</thead>
	<tbody>
		{#each data.roster.filter((entry) => entry.status !== 'cancelled') as entry (entry.signupId)}
			<tr>
				<td>{entry.name}</td>
				<td>{entry.email}</td>
				<td>{entry.phone ?? ''}</td>
				<td>{entry.status}{entry.status === 'waitlisted' ? ` #${entry.waitlistSeq}` : ''}</td>
				<td>{entry.signedUpLabel}</td>
				<td>
					{#if data.started && entry.status === 'confirmed'}
						<form method="POST" action="?/attendance" class="inline" use:enhance>
							<input type="hidden" name="signupId" value={entry.signupId} />
							<input type="hidden" name="attended" value={entry.attended ? 'false' : 'true'} />
							{entry.attended === null ? '—' : entry.attended ? 'yes' : 'no'}
							<button type="submit">{entry.attended ? 'Mark absent' : 'Mark present'}</button>
						</form>
					{:else}
						{entry.attended === null ? '' : entry.attended ? 'yes' : 'no'}
					{/if}
				</td>
				<td>
					{#if !data.ended}
						<form method="POST" action="?/remove" class="inline" use:enhance>
							<input type="hidden" name="signupId" value={entry.signupId} />
							<button type="submit">Remove</button>
						</form>
					{/if}
				</td>
			</tr>
		{:else}
			<tr><td colspan="7">Nobody has signed up yet.</td></tr>
		{/each}
	</tbody>
</table>
