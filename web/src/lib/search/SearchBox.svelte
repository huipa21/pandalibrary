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

<form role="search" aria-label={m['search.landmark']()} class="flex min-w-0 items-center gap-2" action="/search" method="GET" onsubmit={submit}>
	<label class="sr-only" for="app-search">{m['search.label']()}</label>
	<input
		id="app-search"
		name={SEARCH_QUERY_PARAM}
		type="search"
		class="w-40 min-w-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 sm:w-56"
		placeholder={m['search.placeholder']()}
		autocomplete="off"
		bind:value={draft}
	/>
	<button
		type="submit"
		class="shell-search-submit inline-flex size-9 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
		aria-label={m['search.submit']()}
		title={m['search.submit']()}
	>
		<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
			<circle cx="8.5" cy="8.5" r="5.5" />
			<path d="m12.5 12.5 4 4" />
		</svg>
	</button>
</form>
