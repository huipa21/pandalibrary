<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import {
		normalizeSearchInput,
		queryTooLong,
		SEARCH_QUERY_PARAM,
		searchBooks,
		searchErrorKey,
		searchPageHref
	} from '#lib/search/api.js';
	import SearchResultCard from '#lib/search/SearchResultCard.svelte';
	import type { SearchResult } from '#lib/search/types.js';

	const pager = new CursorPager<SearchResult>();
	const query = $derived(normalizeSearchInput(page.url.searchParams.get(SEARCH_QUERY_PARAM)));
	const tooLong = $derived(queryTooLong(query));
	let draft = $state('');
	let validation = $state('');
	let input = $state<HTMLInputElement | null>(null);

	$effect(() => {
		const current = query;
		const rejected = tooLong;
		untrack(() => {
			draft = current;
			validation = rejected ? m['search.too_long']() : '';
			void pager.reset(current && !rejected ? (cursor, signal) => searchBooks(current, { cursor, signal }) : null);
		});
	});

	onDestroy(() => pager.dispose());

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const next = normalizeSearchInput(draft);
		if (queryTooLong(next)) {
			validation = m['search.too_long']();
			return;
		}
		validation = '';
		if (next === query) {
			// Same query: only retry a failed search; a pending or loaded one is not requested again.
			if (pager.status === 'error') await pager.retry();
			return;
		}
		await goto(searchPageHref(next), { reset: false });
	}

	async function clear() {
		draft = '';
		validation = '';
		if (query) await goto('/search', { reset: false });
		await tick();
		input?.focus();
	}

	const errorRestarts = $derived(requestErrorKind(pager.error) === 'invalid');
	const moreErrorRestarts = $derived(requestErrorKind(pager.moreError) === 'invalid');
</script>

<svelte:head>
	<title>{query ? `${query} · ${m['search.title']()}` : m['search.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="search-heading">
	<h1 id="search-heading" class="sr-only">{m['search.title']()}</h1>

	<form role="search" aria-label={m['search.landmark']()} class="flex flex-wrap items-end gap-3" onsubmit={submit} novalidate>
		<label class="grid min-w-0 flex-1 gap-1 text-sm font-medium" for="search-query">
			<span>{m['search.label']()}</span>
			<input
				id="search-query"
				type="search"
				name={SEARCH_QUERY_PARAM}
				class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
				placeholder={m['search.placeholder']()}
				autocomplete="off"
				aria-invalid={validation ? 'true' : undefined}
				aria-describedby={validation ? 'search-validation' : undefined}
				bind:value={draft}
				bind:this={input}
			/>
		</label>
		<button
			type="submit"
			class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
			disabled={pager.status === 'loading'}
		>{m['search.submit']()}</button>
		<button
			type="button"
			class="rounded-md border border-slate-300 px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
			disabled={!draft && !query}
			onclick={clear}
		>{m['search.clear']()}</button>
	</form>
	{#if validation}
		<p id="search-validation" class="text-sm text-red-700" role="alert">{validation}</p>
	{/if}

	{#if !query}
		<p class="card p-6 text-slate-600">{m['search.prompt']()}</p>
	{:else if !tooLong}
		<section class="space-y-4" aria-labelledby="search-results-heading" aria-busy={pager.status === 'loading'}>
			<h2 id="search-results-heading" class="text-xl font-semibold break-words">{m['search.results_heading']({ query })}</h2>
			{#if pager.status === 'error'}
				<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
					<p>{translate(searchErrorKey(pager.error))}</p>
					{#if errorRestarts}
						<button class="underline underline-offset-4 focus-visible:outline-2" onclick={clear}>{m['search.restart']()}</button>
					{:else}
						<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.retry()}>{m['search.retry']()}</button>
					{/if}
				</div>
			{:else if pager.status === 'loading' || pager.status === 'idle'}
				<p class="text-slate-600" role="status">{m['search.loading']()}</p>
			{:else if pager.empty}
				<p class="card p-6 text-slate-600" role="status">{m['search.empty']({ query })}</p>
			{:else}
				<ol class="space-y-3">
					{#each pager.items as result (result.id)}
						<SearchResultCard {result} />
					{/each}
				</ol>
				{#if pager.moreError}
					<div class="flex flex-wrap items-center gap-3 text-red-800" role="alert">
						<p>{translate(searchErrorKey(pager.moreError))}</p>
						{#if moreErrorRestarts}
							<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.reload()}>{m['search.restart']()}</button>
						{:else}
							<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.loadMore()}>{m['search.retry']()}</button>
						{/if}
					</div>
				{/if}
				{#if pager.hasMore}
					<button
						class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
						disabled={pager.loadingMore}
						onclick={() => pager.loadMore()}
					>{pager.loadingMore ? m['search.loading_more']() : m['search.load_more']()}</button>
				{:else}
					<p class="text-center text-sm text-slate-500" role="status">{m['search.end']()}</p>
				{/if}
			{/if}
		</section>
	{/if}
</section>
