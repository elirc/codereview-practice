<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Series · Volunteer Scheduler</title>
</svelte:head>

<h1>Recurring series</h1>
<p><a href="/manage/series/new">New series</a></p>

<table>
	<thead>
		<tr>
			<th>Title</th>
			<th>Location</th>
			<th>Pattern</th>
			<th>Runs</th>
			<th>Upcoming shifts</th>
		</tr>
	</thead>
	<tbody>
		{#each data.series as series (series.id)}
			<tr>
				<td><a href="/manage/series/{series.id}">{series.title}</a></td>
				<td>{series.location}</td>
				<td>{series.freq.toLowerCase()} every {series.interval}, {series.startTime}</td>
				<td>
					from {series.dtstart}
					{#if series.until}until {series.until}{/if}
					{#if series.count}for {series.count} occurrences{/if}
				</td>
				<td>{series.upcoming}</td>
			</tr>
		{:else}
			<tr><td colspan="5">No series yet.</td></tr>
		{/each}
	</tbody>
</table>
