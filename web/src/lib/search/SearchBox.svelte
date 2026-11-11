<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { normalizeSearchInput, SEARCH_QUERY_PARAM, searchPageHref } from './api.js';
	import SearchField from './SearchField.svelte';

	const activeQuery = $derived(
		page.url.pathname === '/search' ? normalizeSearchInput(page.url.searchParams.get(SEARCH_QUERY_PARAM)) : ''
	);
	let draft = $state('');
	let input = $state<HTMLInputElement | null>(null);

	$effect(() => {
		const current = activeQuery;
		untrack(() => {
			draft = current;
		});
	});

	const showClear = $derived(activeQuery !== '' && normalizeSearchInput(draft) === activeQuery);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const next = normalizeSearchInput(draft);
		if (!next || next === activeQuery) return;
		await goto(searchPageHref(next));
	}

	async function clear() {
		draft = '';
		await goto('/search');
		await tick();
		input?.focus();
	}
</script>

<form role="search" aria-label={m['search.landmark']()} class="flex min-w-0 items-center gap-2" action="/search" method="GET" onsubmit={submit}>
	<SearchField
		id="app-search"
		name={SEARCH_QUERY_PARAM}
		class="w-[12.75rem] shrink sm:w-[16.75rem]"
		label={m['search.label']()}
		placeholder={m['search.placeholder']()}
		bind:value={draft}
		bind:input
		clear={showClear}
		buttonLabel={showClear ? m['search.clear']() : m['search.submit']()}
		onsearch={showClear ? clear : undefined}
	/>
</form>