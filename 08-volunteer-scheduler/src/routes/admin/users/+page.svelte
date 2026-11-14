<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const notice = $derived(form && 'notice' in form ? form.notice : null);
	const inviteUrl = $derived(form && 'inviteUrl' in form ? form.inviteUrl : null);
</script>

<svelte:head>
	<title>Users · Volunteer Scheduler</title>
</svelte:head>

<h1>Users</h1>
<FormError {form} />
{#if notice}
	<p class="notice">{notice}</p>
{/if}
{#if inviteUrl}
	<p class="notice">Share this single-use link (valid for 7 days): <code>{inviteUrl}</code></p>
{/if}

<form method="GET">
	<input name="q" value={data.q} placeholder="Name or email" />
	<button type="submit">Search</button>
</form>

<table>
	<thead>
		<tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Password</th></tr>
	</thead>
	<tbody>
		{#each data.users as user (user.id)}
			<tr>
				<td>{user.name}</td>
				<td>{user.email}</td>
				<td>
					<form method="POST" action="?/role" class="inline" use:enhance>
						<input type="hidden" name="userId" value={user.id} />
						<select name="role" value={user.role}>
							<option value="volunteer">volunteer</option>
							<option value="coordinator">coordinator</option>
							<option value="admin">admin</option>
						</select>
						<button type="submit">Save</button>
					</form>
				</td>
				<td>
					<form method="POST" action="?/active" class="inline" use:enhance>
						<input type="hidden" name="userId" value={user.id} />
						<input type="hidden" name="active" value={user.active ? 'false' : 'true'} />
						{user.active ? 'active' : 'inactive'}
						<button type="submit">{user.active ? 'Deactivate' : 'Activate'}</button>
					</form>
				</td>
				<td>
					{#if user.hasPassword}
						set
					{:else}
						<form method="POST" action="?/invite" class="inline" use:enhance>
							<input type="hidden" name="userId" value={user.id} />
							<button type="submit">Create invite link</button>
						</form>
					{/if}
				</td>
			</tr>
		{/each}
	</tbody>
</table>
