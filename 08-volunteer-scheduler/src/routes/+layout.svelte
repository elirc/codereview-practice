<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	const manager = $derived(data.user?.role === 'coordinator' || data.user?.role === 'admin');
</script>

<header>
	<strong>Volunteer Scheduler</strong>
	{#if data.user}
		<nav>
			<a href="/">Upcoming</a>
			<a href="/my">My signups</a>
			<a href="/my/profile">Profile</a>
			{#if manager}
				<a href="/manage/shifts">Shifts</a>
				<a href="/manage/series">Series</a>
			{/if}
			{#if data.user.role === 'admin'}
				<a href="/admin/users">Users</a>
				<a href="/admin/outbox">Outbox</a>
				<a href="/admin/jobs">Jobs</a>
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
