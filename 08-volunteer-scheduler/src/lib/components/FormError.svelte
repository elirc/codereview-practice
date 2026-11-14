<script lang="ts">
	import { errorOf, fieldErrors } from '$lib/forms';

	let { form }: { form: unknown } = $props();

	const error = $derived(errorOf(form));
	const fields = $derived(fieldErrors(form));
</script>

{#if error}
	<div class="error" role="alert">
		<strong>{error.message}</strong>
		<span class="muted">({error.code})</span>
		{#if fields.length > 0}
			<ul>
				{#each fields as field (field.path)}
					<li>{field.path || 'form'}: {field.message}</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
