<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import SeriesForm from '$lib/components/SeriesForm.svelte';
	import { valueOr } from '$lib/forms';
	import { seriesFormValues } from '$lib/series-form';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const values = $derived(seriesFormValues(data.series, form, data.today));
	const notice = $derived(form && 'notice' in form ? form.notice : null);
	const cancelledDates = $derived(
		data.exceptions.filter((e) => e.kind === 'cancelled').map((e) => e.occurrenceDate)
	);
</script>

<svelte:head>
	<title>{data.series.title} · Volunteer Scheduler</title>
</svelte:head>

<p><a href="/manage/series">← All series</a></p>
<h1>{data.series.title}</h1>
<p class="muted">Shifts are created through {data.series.materializedThrough ?? '—'}.</p>

<FormError {form} />
{#if notice}<p class="notice">{notice}</p>{/if}

<h2>Edit series</h2>
<form method="POST" action="?/update" use:enhance>
	<label>
		Apply changes to occurrences from
		<input
			type="date"
			name="effectiveFrom"
			min={data.today}
			max={data.horizonEnd}
			required
			value={valueOr(form, 'effectiveFrom', data.today)}
		/>
	</label>
	{#key data.series}
		<SeriesForm {values} {form} today={data.today} {cancelledDates} />
	{/key}
	<button type="submit">Save series</button>
</form>

<h2>Exceptions</h2>
<table>
	<thead>
		<tr><th>Date</th><th>Kind</th><th>Overrides</th></tr>
	</thead>
	<tbody>
		{#each data.exceptions as exception (exception.id)}
			<tr>
				<td>{exception.occurrenceDate}</td>
				<td>{exception.kind}</td>
				<td>
					{#if exception.startTime}start {exception.startTime}{/if}
					{#if exception.durationMinutes}· {exception.durationMinutes} min{/if}
					{#if exception.capacity}· capacity {exception.capacity}{/if}
					{#if exception.location}· {exception.location}{/if}
				</td>
			</tr>
		{:else}
			<tr><td colspan="3">No exceptions.</td></tr>
		{/each}
	</tbody>
</table>

<form method="POST" action="?/exception" use:enhance>
	<fieldset>
		<legend>Change one occurrence</legend>
		<label>
			Occurrence date
			<input
				type="date"
				name="occurrenceDate"
				required
				value={valueOr(form, 'occurrenceDate', '')}
			/>
		</label>
		<label class="check">
			<input type="radio" name="kind" value="cancelled" checked />
			Cancel it
		</label>
		<label class="check"><input type="radio" name="kind" value="modified" /> Modify it</label>
		<p class="muted">For a modification, fill in only what changes.</p>
		<label>Start time <input type="time" name="startTime" /></label>
		<label>
			Duration (minutes)
			<input type="number" name="durationMinutes" min="15" max="720" />
		</label>
		<label>Capacity <input type="number" name="capacity" min="1" max="500" /></label>
		<label>Location <input name="location" /></label>
		<button type="submit">Save occurrence</button>
	</fieldset>
</form>

<h2>Upcoming shifts</h2>
<table>
	<thead>
		<tr><th>Occurrence</th><th>Starts</th><th>Capacity</th><th>Status</th></tr>
	</thead>
	<tbody>
		{#each data.upcoming as shift (shift.id)}
			<tr>
				<td>{shift.occurrenceDate}{shift.detached ? ' (modified)' : ''}</td>
				<td><a href="/manage/shifts/{shift.id}">{shift.startsLabel}</a></td>
				<td>{shift.capacity}</td>
				<td>{shift.status}</td>
			</tr>
		{:else}
			<tr><td colspan="4">No upcoming shifts.</td></tr>
		{/each}
	</tbody>
</table>

<h2>Delete series</h2>
<form method="POST" action="?/delete" use:enhance>
	<p class="muted">
		Cancels every future shift (volunteers are notified) and ends the series yesterday.
	</p>
	<button type="submit">Delete series</button>
</form>
