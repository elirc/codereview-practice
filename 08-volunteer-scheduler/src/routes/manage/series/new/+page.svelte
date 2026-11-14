<script lang="ts">
	import { enhance } from '$app/forms';
	import FormError from '$lib/components/FormError.svelte';
	import SeriesForm from '$lib/components/SeriesForm.svelte';
	import { seriesFormValues } from '$lib/series-form';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const values = $derived(seriesFormValues(null, form, data.today));
</script>

<svelte:head>
	<title>New series · Volunteer Scheduler</title>
</svelte:head>

<p><a href="/manage/series">← All series</a></p>
<h1>New recurring series</h1>
<FormError {form} />
<form method="POST" use:enhance>
	<SeriesForm {values} {form} today={data.today} />
	<button type="submit">Create series</button>
</form>
