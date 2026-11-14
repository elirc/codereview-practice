<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<header>
	<strong>Volunteer Scheduler</strong>
</header>

<main>
	{@render children()}
</main>
