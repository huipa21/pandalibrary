<script lang="ts">
	import { goto } from '$app/navigation';
	import * as m from '#lib/paraglide/messages.js';
	import { normalizeSearchInput, SEARCH_QUERY_PARAM, searchPageHref } from './api.js';

	let draft = $state('');

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!normalizeSearchInput(draft)) return;
		const href = searchPageHref(draft);
		draft = '';
		await goto(href);
	}
</script>

<form role="search" aria-label={m['search.landmark']()} class="flex items-center gap-2" action="/search" method="GET" onsubmit={submit}>
	<label class="sr-only" for="app-search">{m['search.label']()}</label>
	<input
		id="app-search"
		name={SEARCH_QUERY_PARAM}
		type="search"
		class="w-40 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 sm:w-56"
		placeholder={m['search.placeholder']()}
		autocomplete="off"
		bind:value={draft}
	/>
	<button
		type="submit"
		class="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
	>{m['search.submit']()}</button>
</form>
