<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} · Volunteer Scheduler</title>
</svelte:head>

<h1>{page.status}</h1>
<p>{page.error?.message ?? 'Something went wrong.'}</p>
{#if page.error?.requestId}
	<p class="muted">Request id: {page.error.requestId}</p>
{/if}
