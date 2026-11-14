<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import { valueOr } from '$lib/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Sign in · Volunteer Scheduler</title>
</svelte:head>

<h1>Sign in</h1>
<FormError {form} />
<form method="POST" use:enhance>
	<input type="hidden" name="next" value={data.next} />
	<label>
		Email
		<input
			name="email"
			type="email"
			autocomplete="email"
			required
			value={valueOr(form, 'email', '')}
		/>
	</label>
	<label>
		Password
		<input name="password" type="password" autocomplete="current-password" required />
	</label>
	<button type="submit">Sign in</button>
</form>
