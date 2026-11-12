<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { ReaderSearchEngine } from './search.js';
	import { createReaderSearchState, SEARCH_PAGE_SIZE } from './search-state.svelte.js';

	let { engine }: { engine: ReaderSearchEngine } = $props();
	const search = $derived(createReaderSearchState(engine));
	const id = $props.id();
	$effect(() => {
		const current = search;
		return () => current.dispose();
	});
</script>

<section class="space-y-3 p-3 text-sm" aria-label={m['reader.search.title']()}>
	<form class="space-y-2" role="search" aria-label={m['reader.search.title']()} onsubmit={(event) => { event.preventDefault(); void search.search(); }}>
		<label for={`${id}-query`} class="block font-medium">{m['reader.search.label']()}</label>
		<input id={`${id}-query`} type="search" value={search.query}
			class="w-full rounded border border-[var(--shell-border)] bg-[var(--shell-surface)] p-2 focus-visible:outline-2"
			disabled={search.navigating} autocomplete="off"
			oninput={(event) => search.setQuery(event.currentTarget.value)} />
		<div class="flex flex-wrap gap-2">
			<button class="search-action" type="submit" disabled={!search.query.trim() || search.loading || search.navigating}>{m['reader.search.submit']()}</button>
			<button class="search-action" type="button" disabled={!search.query && !search.loading} onclick={() => search.clear()}>{m['reader.search.clear']()}</button>
		</div>
	</form>
	<div role="status" aria-live="polite" aria-atomic="true">
		{#if search.loading}
			<p>{m['reader.search.loading']()}</p>
		{:else if search.searched}
			<p>{search.results.length ? m['reader.search.count']({ count: search.results.length }) : m['reader.search.empty']()}</p>
		{:else if !search.error}
			<p>{m['reader.search.prompt']()}</p>
		{/if}
		{#if search.active >= 0}
			<p>{m['reader.search.current']({ current: search.active + 1, count: search.results.length })}</p>
		{/if}
	</div>
	{#if search.error}
		<p role="alert">{search.error === 'search' ? m['reader.search.error']() : m['reader.search.navigation_error']()}</p>
	{/if}
	{#if search.results.length}
		<div class="flex flex-wrap gap-2" role="group" aria-label={m['reader.search.matches']()}>
			<button type="button" class="search-action" disabled={search.navigating || search.active <= 0} onclick={() => search.previous()}>{m['reader.search.previous']()}</button>
			<button type="button" class="search-action" disabled={search.navigating || search.active >= search.results.length - 1} onclick={() => search.next()}>{m['reader.search.next']()}</button>
		</div>
		<ol start={search.page * SEARCH_PAGE_SIZE + 1} class="space-y-2" aria-label={m['reader.search.results']()} aria-busy={search.navigating}>
			{#each search.visibleResults as result, index (result.id)}
				<li>
					<button type="button" data-search-result={result.id} class="w-full rounded border border-[var(--shell-border)] p-2 text-left hover:bg-[var(--shell-hover)] focus-visible:outline-2"
						aria-current={search.active === search.page * SEARCH_PAGE_SIZE + index ? 'location' : undefined}
						disabled={search.navigating} onclick={() => search.select(search.page * SEARCH_PAGE_SIZE + index)}>
						{#if result.label || result.page !== undefined}
							<span class="mb-1 block text-xs text-[var(--shell-muted)]">{result.label || m['reader.search.page']({ page: result.page! })}</span>
						{/if}
						<span class="whitespace-pre-wrap break-words">{result.excerpt.before}<mark>{result.excerpt.match}</mark>{result.excerpt.after}</span>
					</button>
				</li>
			{/each}
		</ol>
		{#if search.pageCount > 1}
			<nav class="flex flex-wrap items-center gap-2" aria-label={m['reader.search.pagination']()}>
				<button type="button" class="search-action" disabled={search.navigating || search.page === 0} onclick={() => search.setPage(search.page - 1)}>{m['reader.search.previous_page']()}</button>
				<span role="status" data-search-page={search.page + 1}>{m['reader.search.page_of']({ page: search.page + 1, count: search.pageCount })}</span>
				<button type="button" class="search-action" disabled={search.navigating || search.page + 1 >= search.pageCount} onclick={() => search.setPage(search.page + 1)}>{m['reader.search.next_page']()}</button>
			</nav>
		{/if}
	{/if}
</section>

<style>
	.search-action {
		border: 1px solid var(--shell-border);
		border-radius: 0.25rem;
		padding: 0.375rem 0.5rem;
	}
	.search-action:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
	.search-action:disabled { opacity: 0.5; }
</style>
