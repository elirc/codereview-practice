<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Jobs · Volunteer Scheduler</title>
</svelte:head>

<h1>Scheduled jobs</h1>
<table>
	<thead>
		<tr>
			<th>Job</th>
			<th>Every</th>
			<th>Next run</th>
			<th>Running since</th>
			<th>Last started</th>
			<th>Last finished</th>
			<th>Last status</th>
			<th>Failures in a row</th>
			<th>Last error</th>
		</tr>
	</thead>
	<tbody>
		{#each data.jobs as job (job.name)}
			<tr>
				<td>{job.name}</td>
				<td>{job.intervalSeconds} s</td>
				<td>{job.nextRunAt}{job.due ? ' (due)' : ''}</td>
				<td>{job.locked ? job.lockedAt : ''}</td>
				<td>{job.lastStartedAt}</td>
				<td>{job.lastFinishedAt}</td>
				<td>{job.lastStatus}</td>
				<td>{job.consecutiveFailures}</td>
				<td>{job.lastError}</td>
			</tr>
		{/each}
	</tbody>
</table>
