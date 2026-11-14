<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Volunteers · Volunteer Scheduler</title>
</svelte:head>

<h1>Volunteers</h1>
<p><a href="/manage/volunteers/import">Import volunteers from CSV</a></p>

<form method="GET">
	<input name="q" value={data.filter.q} placeholder="Name or email" />
	<select name="role" value={data.filter.role}>
		<option value="">any role</option>
		<option value="volunteer">volunteer</option>
		<option value="coordinator">coordinator</option>
		<option value="admin">admin</option>
	</select>
	<button type="submit">Search</button>
</form>

<table>
	<thead>
		<tr>
			<th>Name</th>
			<th>Email</th>
			<th>Phone</th>
			<th>Role</th>
			<th>Notifications</th>
			<th>Account</th>
		</tr>
	</thead>
	<tbody>
		{#each data.volunteers as person (person.id)}
			<tr>
				<td>{person.name}</td>
				<td>{person.email}</td>
				<td>{person.phone}</td>
				<td>{person.role}</td>
				<td>{person.notifications}</td>
				<td>
					{person.active ? 'active' : 'inactive'}
					{#if person.invitePending}<span class="muted">(invite pending)</span>{/if}
				</td>
			</tr>
		{:else}
			<tr><td colspan="6">Nobody matches.</td></tr>
		{/each}
	</tbody>
</table>
