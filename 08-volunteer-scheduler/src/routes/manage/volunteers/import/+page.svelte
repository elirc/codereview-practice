<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	const report = $derived(form && 'report' in form ? form.report : null);
</script>

<svelte:head>
	<title>Import volunteers · Volunteer Scheduler</title>
</svelte:head>

<p><a href="/manage/volunteers">← Volunteers</a></p>
<h1>Import volunteers</h1>
<p>
	Columns: <code>name,email,phone,role,sms_opt_in</code>. A header row is required; name and email
	are mandatory. Existing volunteers are updated by email (their role never changes). New volunteers
	get an invite link to set a password; no notification is sent.
</p>

<FormError {form} />

<form method="POST" enctype="multipart/form-data" use:enhance>
	<label>
		CSV file (up to 2 MiB and 5,000 rows)
		<input type="file" name="file" accept=".csv,text/csv" required />
	</label>
	<label class="check">
		<input type="radio" name="mode" value="dry_run" checked /> Dry run (check only)
	</label>
	<label class="check"><input type="radio" name="mode" value="commit" /> Import</label>
	<p><button type="submit">Upload</button></p>
</form>

{#if report}
	<h2>{report.mode === 'dry_run' ? 'Dry run result' : 'Import result'}</h2>
	<p>
		{report.totalRows} rows: {report.created} new, {report.updated} updated,
		{report.failed} with errors.
	</p>
	{#if report.warnings.length > 0}
		<ul>
			{#each report.warnings as warning, index (index)}
				<li class="muted">{warning.message}</li>
			{/each}
		</ul>
	{/if}
	{#if report.errors.length > 0}
		<table>
			<thead>
				<tr><th>Row</th><th>Line</th><th>Column</th><th>Problem</th></tr>
			</thead>
			<tbody>
				{#each report.errors as error, index (index)}
					<tr>
						<td>{error.rowNumber}</td>
						<td>{error.line}</td>
						<td>{error.column ?? ''}</td>
						<td>{error.message} <span class="muted">({error.code})</span></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	{#if report.invites.length > 0}
		<h3>Invite links</h3>
		<p class="muted">Each link works once and expires in 7 days. They are not shown again.</p>
		<table>
			<thead>
				<tr><th>Row</th><th>Name</th><th>Email</th><th>Link</th></tr>
			</thead>
			<tbody>
				{#each report.invites as invite (invite.email)}
					<tr>
						<td>{invite.rowNumber}</td>
						<td>{invite.name}</td>
						<td>{invite.email}</td>
						<td><code>{invite.url}</code></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
{/if}
