<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Set your password · Volunteer Scheduler</title>
</svelte:head>

<h1>Set your password</h1>
{#if data.invite}
	<p>Welcome, {data.invite.name} ({data.invite.email}). Choose a password to finish signing up.</p>
	<FormError {form} />
	<form method="POST" use:enhance>
		<label>
			Password
			<input name="password" type="password" autocomplete="new-password" minlength="10" required />
		</label>
		<label>
			Confirm password
			<input name="passwordConfirm" type="password" autocomplete="new-password" required />
		</label>
		<button type="submit">Set password</button>
	</form>
{:else}
	<p class="error">This invite link is invalid, has already been used, or has expired.</p>
{/if}
