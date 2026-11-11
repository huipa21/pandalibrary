<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { catalogErrorMessage } from './errors.js';
	import { listAllEntities, listBooks } from './api.js';
	import { filterControlClass } from './filter-styles.js';
	import { allowsCatalogFilters, bookFiltersFromSearch, bookPageOptions, hasNextPage, selectedSort, setCatalogFilter } from './query.js';
	import type { Book, BookFilters, BookSort, CatalogEntity, EntityKind } from './types.js';
	import BookCard from './BookCard.svelte';
	import ClearFiltersButton from './ClearFiltersButton.svelte';
	import ViewToggle from './ViewToggle.svelte';
	import { rememberBrowseContext } from '#lib/bookview/browse-context.js';

	let { scope, showHeading = true, rememberSettings = false }: { scope: BookFilters; showHeading?: boolean; rememberSettings?: boolean } = $props();
	const filtersKey = 'pandalibrary.books.filters';
	const viewKey = 'pandalibrary.books.view';
	const settingKeys = ['author_id', 'series_id', 'tag_id', 'sort'] as const;
	let settingsReady = $state(false);
	let books = $state<Book[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state('');
	let moreError = $state('');
	let optionsError = $state('');
	let optionsLoading = $state(false);
	let authors = $state<CatalogEntity[]>([]);
	let series = $state<CatalogEntity[]>([]);
	let tags = $state<CatalogEntity[]>([]);
	let mode = $state<'grid' | 'list'>('grid');
	let reloadVersion = $state(0);
	let requestVersion = 0;
	const selectedAuthor = $derived(page.url.searchParams.get('author_id') ?? '');
	const selectedSeries = $derived(page.url.searchParams.get('series_id') ?? '');
	const selectedTag = $derived(page.url.searchParams.get('tag_id') ?? '');
	const sort = $derived(
		selectedSort(
			page.url.searchParams,
			bookFiltersFromSearch(scope, page.url.searchParams).series_id
		)
	);
	const hasSeriesFilter = $derived(
		bookFiltersFromSearch(scope, page.url.searchParams).series_id !== undefined
	);

	const filterable = $derived(allowsCatalogFilters(scope));

	onMount(() => {
		if (filterable) void loadFilterOptions();
		void restoreSettings();
	});

	async function restoreSettings() {
		try {
			if (rememberSettings) {
				const savedMode = localStorage.getItem(viewKey);
				if (savedMode === 'grid' || savedMode === 'list') mode = savedMode;
				const savedFilters = localStorage.getItem(filtersKey);
				if (savedFilters && !settingKeys.some((key) => page.url.searchParams.has(key))) {
					const params = new URLSearchParams(page.url.searchParams.toString());
					const saved = new URLSearchParams(savedFilters);
					for (const key of settingKeys) {
						const value = saved.get(key);
						if (value) params.set(key, value);
					}
					if (params.toString() !== page.url.searchParams.toString()) {
						await goto(`${page.url.pathname}?${params}`, { replaceState: true });
					}
				}
			}
		} catch {
		} finally {
			settingsReady = true;
		}
	}

	$effect(() => {
		if (!rememberSettings || !settingsReady || page.url.pathname !== '/books') return;
		const params = new URLSearchParams();
		for (const key of settingKeys) {
			const value = page.url.searchParams.get(key);
			if (value) params.set(key, value);
		}
		try {
			localStorage.setItem(filtersKey, params.toString());
			localStorage.setItem(viewKey, mode);
		} catch {
		}
	});

	$effect(() => { if (!loading && !error) rememberBrowseContext({ ids: books.map((book) => book.id), label: document.querySelector('main h1')?.textContent?.trim() || m['catalog.books.title'](), href: `${page.url.pathname}${page.url.search}` }); });

	$effect(() => {
		if (!settingsReady) return;
		const search = page.url.searchParams.toString();
		const currentScope = scope;
		const refresh = reloadVersion;
		void loadFirstPage(search, currentScope, refresh);
	});

	async function loadFilterOptions() {
		optionsLoading = true;
		optionsError = '';
		try {
			[authors, series, tags] = await Promise.all([
				listAllEntities('authors'),
				listAllEntities('series'),
				listAllEntities('tags')
			]);
		} catch (cause) {
			optionsError = catalogErrorMessage(cause, {
				api: m['catalog.error.api'](),
				connection: m['catalog.error.connection'](),
				notFound: m['catalog.error.not_found']()
			});
		} finally {
			optionsLoading = false;
		}
	}

	async function loadFirstPage(search: string, filters: BookFilters, _refresh: number) {
		const request = ++requestVersion;
		books = [];
		nextCursor = null;
		loading = true;
		error = '';
		moreError = '';
		try {
			const params = new URLSearchParams(search);
			const effectiveFilters = bookFiltersFromSearch(filters, params);
			const effectiveSort: BookSort = selectedSort(params, effectiveFilters.series_id);
			const result = await listBooks(effectiveFilters, effectiveSort);
			if (request !== requestVersion) return;
			books = result.items;
			nextCursor = result.next_cursor;
		} catch (cause) {
			if (request !== requestVersion) return;
			error = catalogErrorMessage(cause, {
				api: m['catalog.error.api'](),
				connection: m['catalog.error.connection'](),
				notFound: m['catalog.error.not_found']()
			});
		} finally {
			if (request === requestVersion) loading = false;
		}
	}

	async function loadMore() {
		if (!nextCursor || loadingMore) return;
		const request = requestVersion;
		const cursor = nextCursor;
		loadingMore = true;
		moreError = '';
		try {
			const params = new URLSearchParams(page.url.searchParams.toString());
			const effectiveFilters = bookFiltersFromSearch(scope, params);
			const effectiveSort = selectedSort(params, effectiveFilters.series_id);
			const result = await listBooks(effectiveFilters, effectiveSort, bookPageOptions(cursor));
			if (request !== requestVersion) return;
			books = [...books, ...result.items];
			nextCursor = result.next_cursor;
		} catch (cause) {
			if (request !== requestVersion) return;
			moreError = catalogErrorMessage(cause, {
				api: m['catalog.error.api'](),
				connection: m['catalog.error.connection'](),
				notFound: m['catalog.error.not_found']()
			});
		} finally {
			if (request === requestVersion) loadingMore = false;
		}
	}

	async function changeQuery(key: 'author_id' | 'series_id' | 'tag_id' | 'sort', value: string) {
		const params = setCatalogFilter(
			new URLSearchParams(page.url.searchParams.toString()),
			key,
			value
		);
		const query = params.toString();
		const href = `${page.url.pathname}${query ? `?${query}` : ''}`;
		try {
			await goto(href, { replaceState: true });
		} catch {
			error = m['catalog.error.navigation']();
		}
	}

	async function clearFilters() {
		try {
			await goto(page.url.pathname, { replaceState: true });
		} catch {
			error = m['catalog.error.navigation']();
		}
	}
</script>

<section class="space-y-5" aria-labelledby="book-results-heading">
	<div class="flex flex-wrap items-end justify-between gap-4">
		<h2 id="book-results-heading" class={showHeading ? 'text-xl font-semibold' : 'sr-only'}>{m['catalog.books.title']()}</h2>
		<div class="flex flex-wrap items-end gap-3">
			{#if filterable}
				<div class="flex flex-wrap gap-3" role="group" aria-label={m['catalog.books.filter_group']()}>
					<label class="grid gap-1 text-sm font-medium" for="filter-author">
						<span>{m['catalog.books.author_filter']()}</span>
						<select
							id="filter-author"
							class="{filterControlClass} min-w-40"
							disabled={optionsLoading || Boolean(optionsError)}
							value={selectedAuthor}
							onchange={(event) => changeQuery('author_id', event.currentTarget.value)}
						>
							<option value="">{m['catalog.books.all_authors']()}</option>
							{#each authors as author (author.id)}
								<option value={String(author.id)}>{author.name}</option>
							{/each}
						</select>
					</label>
					<label class="grid gap-1 text-sm font-medium" for="filter-series">
						<span>{m['catalog.books.series_filter']()}</span>
						<select
							id="filter-series"
							class="{filterControlClass} min-w-40"
							disabled={optionsLoading || Boolean(optionsError)}
							value={selectedSeries}
							onchange={(event) => changeQuery('series_id', event.currentTarget.value)}
						>
							<option value="">{m['catalog.books.all_series']()}</option>
							{#each series as item (item.id)}
								<option value={String(item.id)}>{item.name}</option>
							{/each}
						</select>
					</label>
					<label class="grid gap-1 text-sm font-medium" for="filter-tag">
						<span>{m['catalog.books.tag_filter']()}</span>
						<select
							id="filter-tag"
							class="{filterControlClass} min-w-40"
							disabled={optionsLoading || Boolean(optionsError)}
							value={selectedTag}
							onchange={(event) => changeQuery('tag_id', event.currentTarget.value)}
						>
							<option value="">{m['catalog.books.all_tags']()}</option>
							{#each tags as tag (tag.id)}
								<option value={String(tag.id)}>{tag.name}</option>
							{/each}
						</select>
					</label>
				</div>
			{/if}
			<label class="grid gap-1 text-sm font-medium" for="sort-books">
				<span>{m['catalog.books.sort']()}</span>
				<select
					id="sort-books"
					class={filterControlClass}
					value={sort}
					onchange={(event) => changeQuery('sort', event.currentTarget.value)}
				>
					<option value="title">{m['catalog.books.sort_title']()}</option>
					<option value="added">{m['catalog.books.sort_added']()}</option>
					{#if hasSeriesFilter}
						<option value="series">{m['catalog.books.sort_series']()}</option>
					{/if}
				</select>
			</label>
			<ViewToggle view={mode} onchange={(next) => (mode = next)} />
			{#if filterable}
				<ClearFiltersButton
					label={m['catalog.books.clear_filters']()}
					onclick={clearFilters}
					disabled={!selectedAuthor && !selectedSeries && !selectedTag && sort === 'title'}
				/>
			{/if}
		</div>
	</div>

	{#if optionsLoading}
		<p class="text-sm text-slate-600" role="status">{m['catalog.books.loading_filters']()}</p>
	{:else if optionsError}
		<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
			<p>{optionsError}</p>
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={loadFilterOptions}>{m['catalog.retry']()}</button>
		</div>
	{/if}

	{#if error}
		<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
			<p>{error}</p>
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => (reloadVersion += 1)}>{m['catalog.retry']()}</button>
		</div>
	{:else if loading}
		<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
	{:else if books.length === 0}
		<p class="card p-6 text-slate-600">{m['catalog.books.empty']()}</p>
	{:else}
		<ul class={mode === 'grid' ? 'book-grid' : 'space-y-3'}>
			{#each books as book (book.id)}
				<BookCard {book} {mode} />
			{/each}
		</ul>
		{#if moreError}
			<div class="flex flex-wrap items-center gap-3 text-red-800" role="alert">
				<p>{moreError}</p>
				<button class="underline underline-offset-4 focus-visible:outline-2" onclick={loadMore}>{m['catalog.retry']()}</button>
			</div>
		{/if}
		{#if hasNextPage(nextCursor)}
			<button
				class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
				disabled={loadingMore}
				onclick={loadMore}
			>{loadingMore ? m['catalog.books.loading_more']() : m['catalog.books.load_more']()}</button>
		{:else}
			<p class="text-center text-sm text-slate-500" role="status">{m['catalog.books.end']()}</p>
		{/if}
	{/if}
</section>
