<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { normalizeSearchInput, SEARCH_QUERY_PARAM, searchPageHref } from './api.js';

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
	<label class="sr-only" for="app-search">{m['search.label']()}</label>
	<input
		id="app-search"
		name={SEARCH_QUERY_PARAM}
		type="search"
		class="w-40 min-w-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 sm:w-56"
		placeholder={m['search.placeholder']()}
		autocomplete="off"
		bind:value={draft}
		bind:this={input}
	/>
	{#if showClear}
		<button
			type="button"
			class="shell-search-submit inline-flex size-9 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
			aria-label={m['search.clear']()}
			title={m['search.clear']()}
			onclick={clear}
		>
			<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
				<path d="M5 5l10 10M15 5L5 15" />
			</svg>
		</button>
	{:else}
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
	{/if}
</form>

<style>
	/* The clear button replaces Chromium/Safari's built-in cancel icon, which would otherwise duplicate it. */
	input::-webkit-search-cancel-button {
		-webkit-appearance: none;
		appearance: none;
	}
</style>