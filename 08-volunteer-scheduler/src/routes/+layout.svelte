<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<header>
	<strong>Volunteer Scheduler</strong>
	{#if data.user}
		<nav>
			{#if data.user.role === 'admin'}
				<a href="/admin/users">Users</a>
			{/if}
		</nav>
		<span class="muted">{data.user.name} ({data.user.role})</span>
		<form method="POST" action="/logout" class="inline">
			<button type="submit">Sign out</button>
		</form>
	{/if}
</header>

<main>
	{@render children()}
</main>
