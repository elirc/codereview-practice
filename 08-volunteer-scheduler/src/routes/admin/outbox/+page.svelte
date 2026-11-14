<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const notice = $derived(form && 'notice' in form ? form.notice : null);
</script>

<svelte:head>
	<title>Outbox · Volunteer Scheduler</title>
</svelte:head>

<h1>Notification outbox</h1>
<FormError {form} />
{#if notice}<p class="notice">{notice}</p>{/if}

<p>
	<a href="/admin/outbox">all</a>
	{#each data.statuses as status (status)}
		· <a href="/admin/outbox?status={status}">{status} ({data.counts[status] ?? 0})</a>
	{/each}
</p>

<table>
	<thead>
		<tr>
			<th>Created</th>
			<th>Recipient</th>
			<th>Template</th>
			<th>Status</th>
			<th>Attempts</th>
			<th>Next attempt / sent</th>
			<th>Last error</th>
			<th></th>
		</tr>
	</thead>
	<tbody>
		{#each data.rows as row (row.id)}
			<tr>
				<td>{row.createdAt}</td>
				<td>{row.email} ({row.channel})</td>
				<td title={row.dedupeKey}>{row.template}</td>
				<td>{row.status}</td>
				<td>{row.attempts}</td>
				<td>{row.status === 'sent' ? row.sentAt : row.nextAttemptAt}</td>
				<td>{row.lastError ?? ''}</td>
				<td>
					{#if row.status === 'dead'}
						<form method="POST" action="?/retry" class="inline" use:enhance>
							<input type="hidden" name="id" value={row.id} />
							<button type="submit">Retry</button>
						</form>
					{/if}
				</td>
			</tr>
		{:else}
			<tr>
				<td colspan="8">No notifications{data.status ? ` with status ${data.status}` : ''}.</td>
			</tr>
		{/each}
	</tbody>
</table>
