<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import { valueOr } from '$lib/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Shifts · Volunteer Scheduler</title>
</svelte:head>

<h1>Shifts</h1>

<form method="GET">
	<label class="check">From <input type="date" name="from" value={data.filter.from} /></label>
	<label class="check">To <input type="date" name="to" value={data.filter.to} /></label>
	<label class="check">
		Status
		<select name="status" value={data.filter.status}>
			<option value="">any</option>
			<option value="scheduled">scheduled</option>
			<option value="cancelled">cancelled</option>
		</select>
	</label>
	<label class="check">Title <input name="q" value={data.filter.q} /></label>
	<button type="submit">Filter</button>
</form>
<p>
	<a href="/exports/signups.csv?from={data.filter.from}&to={data.filter.to}" download>
		Download signups for this date range (CSV)
	</a>
</p>

<table>
	<thead>
		<tr>
			<th>When</th>
			<th>Shift</th>
			<th>Location</th>
			<th>Confirmed</th>
			<th>Waitlist</th>
			<th>Status</th>
		</tr>
	</thead>
	<tbody>
		{#each data.shifts as shift (shift.id)}
			<tr>
				<td>{shift.date} {shift.startTime}–{shift.endTime}</td>
				<td>
					<a href="/manage/shifts/{shift.id}">{shift.title}</a>
					{#if shift.seriesId}<span class="muted">(series)</span>{/if}
				</td>
				<td>{shift.location}</td>
				<td>
					{shift.confirmed} / {shift.capacity}
					{#if shift.confirmed > shift.capacity}<strong>over capacity</strong>{/if}
				</td>
				<td>{shift.waitlisted}</td>
				<td>{shift.status}</td>
			</tr>
		{:else}
			<tr><td colspan="6">No shifts in this range.</td></tr>
		{/each}
	</tbody>
</table>

<h2>New one-off shift</h2>
<FormError {form} />
<form method="POST" action="?/create" use:enhance>
	<label>Title <input name="title" required value={valueOr(form, 'title', '')} /></label>
	<label>Location <input name="location" required value={valueOr(form, 'location', '')} /></label>
	<label>
		Date
		<input type="date" name="date" required value={valueOr(form, 'date', data.today)} />
	</label>
	<label>
		Start time
		<input type="time" name="startTime" required value={valueOr(form, 'startTime', '09:00')} />
	</label>
	<label>
		Duration (minutes)
		<input
			type="number"
			name="durationMinutes"
			min="15"
			max="720"
			required
			value={valueOr(form, 'durationMinutes', 120)}
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
			value={valueOr(form, 'capacity', 5)}
		/>
	</label>
	<button type="submit">Create shift</button>
</form>
