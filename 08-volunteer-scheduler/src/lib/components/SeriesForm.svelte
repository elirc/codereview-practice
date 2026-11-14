<script lang="ts">
	import { isCivilDate } from '$lib/domain/dates';
	import {
		nextOccurrences,
		WEEKDAYS,
		type Frequency,
		type RecurrenceRule,
		type Weekday
	} from '$lib/domain/recurrence';
	import { fieldError } from '$lib/forms';
	import type { SeriesFormValues } from '$lib/series-form';

	let {
		values,
		today,
		form,
		cancelledDates = []
	}: {
		values: SeriesFormValues;
		today: string;
		form: unknown;
		cancelledDates?: string[];
	} = $props();

	let freq = $state(values.freq);
	let interval = $state(values.interval);
	let byWeekday = $state([...values.byWeekday]);
	let byMonthDay = $state(values.byMonthDay);
	let dtstart = $state(values.dtstart);
	let until = $state(values.until);
	let count = $state(values.count);

	const preview = $derived.by(() => {
		const step = Number(interval);
		if (!isCivilDate(dtstart) || !Number.isInteger(step) || step < 1 || step > 52) return [];
		const rule: RecurrenceRule = {
			freq: freq as Frequency,
			interval: step,
			byWeekday: freq === 'WEEKLY' ? (byWeekday as Weekday[]) : null,
			byMonthDay: freq === 'MONTHLY' && byMonthDay.trim() !== '' ? Number(byMonthDay) : null,
			dtstart,
			until: isCivilDate(until) ? until : null,
			count: count.trim() !== '' && Number.isInteger(Number(count)) ? Number(count) : null
		};
		return nextOccurrences(rule, today, 10);
	});
</script>

<fieldset>
	<legend>Details</legend>
	<label>Title <input name="title" required value={values.title} /></label>
	<label>Location <input name="location" required value={values.location} /></label>
	<label>Description <textarea name="description" rows="2">{values.description}</textarea></label>
	<label>Start time <input type="time" name="startTime" required value={values.startTime} /></label>
	<label>
		Duration (minutes)
		<input
			type="number"
			name="durationMinutes"
			min="15"
			max="720"
			required
			value={values.durationMinutes}
		/>
	</label>
	<label>
		Capacity
		<input type="number" name="capacity" min="1" max="500" required value={values.capacity} />
	</label>
</fieldset>

<fieldset>
	<legend>Repeats</legend>
	<label>
		Frequency
		<select name="freq" bind:value={freq}>
			<option value="DAILY">daily</option>
			<option value="WEEKLY">weekly</option>
			<option value="MONTHLY">monthly</option>
		</select>
	</label>
	<label>
		Every
		<input name="interval" inputmode="numeric" size="3" bind:value={interval} />
		period(s)
	</label>
	{#if freq === 'WEEKLY'}
		<div>
			On
			{#each WEEKDAYS as day (day)}
				<label class="check">
					<input type="checkbox" name="byWeekday" value={day} bind:group={byWeekday} />
					{day}
				</label>
			{/each}
			{#if fieldError(form, 'byWeekday')}
				<span class="field-error">{fieldError(form, 'byWeekday')}</span>
			{/if}
		</div>
	{/if}
	{#if freq === 'MONTHLY'}
		<label>
			Day of month (-1 for the last day)
			<input name="byMonthDay" inputmode="numeric" size="3" bind:value={byMonthDay} />
		</label>
	{/if}
	<label>Starting <input type="date" name="dtstart" required bind:value={dtstart} /></label>
	<label>Until (inclusive, optional) <input type="date" name="until" bind:value={until} /></label>
	<label>
		Or number of occurrences
		<input name="count" inputmode="numeric" size="4" bind:value={count} />
	</label>
</fieldset>

<section>
	<h3>Next occurrences</h3>
	{#if preview.length === 0}
		<p class="muted">No upcoming occurrences.</p>
	{:else}
		<ol>
			{#each preview as date (date)}
				<li>
					{date}
					{#if cancelledDates.includes(date)}<span class="muted">(cancelled)</span>{/if}
				</li>
			{/each}
		</ol>
	{/if}
</section>
