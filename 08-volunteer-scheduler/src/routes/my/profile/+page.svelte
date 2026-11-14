<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import { fieldError, valueOr } from '$lib/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const notice = $derived(form && 'notice' in form ? form.notice : null);
</script>

<svelte:head>
	<title>Profile · Volunteer Scheduler</title>
</svelte:head>

<h1>Profile</h1>
<FormError {form} />
{#if notice}<p class="notice">{notice}</p>{/if}

<form method="POST" use:enhance>
	<p>Email: {data.profile.email}</p>
	<label>
		Name
		<input name="name" required value={valueOr(form, 'name', data.profile.name)} />
	</label>
	<label>
		Mobile phone
		<input name="phone" type="tel" value={valueOr(form, 'phone', data.profile.phone)} />
		{#if fieldError(form, 'phone')}<span class="field-error">{fieldError(form, 'phone')}</span>{/if}
	</label>
	<label class="check">
		<input type="checkbox" name="emailOptIn" checked={data.profile.emailOptIn} />
		Email me confirmations, reminders and changes
	</label>
	<label class="check">
		<input type="checkbox" name="smsOptIn" checked={data.profile.smsOptIn} />
		Text me (needs a phone number; no texts between 21:00 and 08:00)
	</label>
	<p><button type="submit">Save</button></p>
</form>
