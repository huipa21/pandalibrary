<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { onMount, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { catalogErrorMessage } from './errors.js';
	import { listAllEntities, listBooks, type BulkBookOutcome } from './api.js';
	import { controlIconClass, filterControlClass, iconControlClass } from './filter-styles.js';
	import { allowsCatalogFilters, bookFiltersFromSearch, bookPageOptions, hasNextPage, selectedSort, setCatalogFilter } from './query.js';
	import type { Book, BookFilters, BookSort, CatalogEntity, EntityKind } from './types.js';
	import BookCard from './BookCard.svelte';
	import BulkBookActions from './BulkBookActions.svelte';
	import ClearFiltersButton from './ClearFiltersButton.svelte';
	import ViewToggle from './ViewToggle.svelte';
	import BookDisplayPresets from './BookDisplayPresets.svelte';
	import { bookDisplay } from './book-display.svelte.js';
	import { rememberBrowseContext } from '#lib/bookview/browse-context.js';
	import { BOOKHEAP_CHANGED_EVENT } from '#lib/bookheap/events.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { BOOKS_CHANGED_EVENT } from './events.js';
	import { getSessionViewer } from '#lib/shelves/api.js';
	import { isAdministrator } from '#lib/shelves/form.js';
	import Icon from '#lib/bookview/Icon.svelte';

	let {
		scope,
		showHeading = true,
		rememberSettings = false,
		fetchBooks = listBooks,
		bookErrorMessage,
		bookActions,
		refreshKey = 0,
		selectionEnabled = false,
		showCoverSize = false
	}: {
		scope: BookFilters;
		showHeading?: boolean;
		rememberSettings?: boolean;
		fetchBooks?: typeof listBooks;
		bookErrorMessage?: (cause: unknown, more: boolean) => string;
		bookActions?: Snippet<[Book]>;
		refreshKey?: number;
		/** Offers multi-select and bulk move/delete controls when the viewer is an administrator. */
		selectionEnabled?: boolean;
		/** Shows the one-button cover-size cycle control. */
		showCoverSize?: boolean;
	} = $props();
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
	let staleMore = $state(false);
	let optionsError = $state('');
	let optionsLoading = $state(false);
	let authors = $state<CatalogEntity[]>([]);
	let series = $state<CatalogEntity[]>([]);
	let tags = $state<CatalogEntity[]>([]);
	let mode = $state<'grid' | 'list'>('grid');
	let reloadVersion = $state(0);
	let requestVersion = 0;
	let canManageBooks = $state(false);
	let selecting = $state(false);
	let selectedIDs = $state<number[]>([]);
	let bulkNotice = $state('');
	let bulkAlert = $state(false);
	const selectedBooks = $derived(books.filter((book) => selectedIDs.includes(book.id)));
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
		if (selectionEnabled) void loadSelectionAccess();
		void restoreSettings();
		const changed = () => { reloadVersion += 1; };
		window.addEventListener(BOOKS_CHANGED_EVENT, changed);
		window.addEventListener(BOOKHEAP_CHANGED_EVENT, changed);
		return () => {
			window.removeEventListener(BOOKS_CHANGED_EVENT, changed);
			window.removeEventListener(BOOKHEAP_CHANGED_EVENT, changed);
		};
	});

	async function loadSelectionAccess() {
		try {
			canManageBooks = isAdministrator(await getSessionViewer());
		} catch (cause) {
			console.error('Could not determine whether bulk book actions are available', cause);
		}
	}

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
		refreshKey;
		const fetch = fetchBooks;
		void loadFirstPage(search, currentScope, refresh, fetch);
	});

	function browseError(cause: unknown, more: boolean): string {
		return bookErrorMessage?.(cause, more) ?? catalogErrorMessage(cause, {
			api: m['catalog.error.api'](),
			connection: m['catalog.error.connection'](),
			notFound: m['catalog.error.not_found']()
		});
	}

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

	async function loadFirstPage(search: string, filters: BookFilters, _refresh: number, fetch: typeof listBooks) {
		const request = ++requestVersion;
		books = [];
		nextCursor = null;
		loading = true;
		loadingMore = false;
		error = '';
		moreError = '';
		staleMore = false;
		try {
			const params = new URLSearchParams(search);
			const effectiveFilters = bookFiltersFromSearch(filters, params);
			const effectiveSort: BookSort = selectedSort(params, effectiveFilters.series_id);
			const result = await fetch(effectiveFilters, effectiveSort);
			if (request !== requestVersion) return;
			books = result.items;
			selectedIDs = selectedIDs.filter((id) => result.items.some((book) => book.id === id));
			nextCursor = result.next_cursor;
		} catch (cause) {
			if (request !== requestVersion) return;
			error = browseError(cause, false);
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
		staleMore = false;
		try {
			const params = new URLSearchParams(page.url.searchParams.toString());
			const effectiveFilters = bookFiltersFromSearch(scope, params);
			const effectiveSort = selectedSort(params, effectiveFilters.series_id);
			const result = await fetchBooks(effectiveFilters, effectiveSort, bookPageOptions(cursor));
			if (request !== requestVersion) return;
			books = [...books, ...result.items];
			nextCursor = result.next_cursor;
		} catch (cause) {
			if (request !== requestVersion) return;
			moreError = browseError(cause, true);
			staleMore = requestErrorKind(cause) === 'invalid';
		} finally {
			if (request === requestVersion) loadingMore = false;
		}
	}

	async function changeQuery(key: 'author_id' | 'series_id' | 'tag_id' | 'sort', value: string) {
		clearBulkFeedback();
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
		clearBulkFeedback();
		const params = new URLSearchParams(page.url.searchParams.toString());
		for (const key of [...settingKeys, 'cursor']) params.delete(key);
		const query = params.toString();
		try {
			await goto(`${page.url.pathname}${query ? `?${query}` : ''}`, { replaceState: true });
		} catch {
			error = m['catalog.error.navigation']();
		}
	}

	function clearBulkFeedback() {
		bulkNotice = '';
		bulkAlert = false;
	}

	function toggleSelectionMode() {
		selecting = !selecting;
		if (!selecting) selectedIDs = [];
		clearBulkFeedback();
	}

	function toggleBook(bookID: number, selected: boolean) {
		selectedIDs = selected
			? [...new Set([...selectedIDs, bookID])]
			: selectedIDs.filter((id) => id !== bookID);
		clearBulkFeedback();
	}

	function finishBulk(action: 'move' | 'delete', outcome: BulkBookOutcome) {
		const succeeded = new Set(outcome.succeeded);
		selectedIDs = selectedIDs.filter((id) => !succeeded.has(id));
		bulkAlert = outcome.failed.length > 0;
		if (bulkAlert) {
			bulkNotice = action === 'move'
				? m['catalog.selection.move_partial']({ moved: outcome.succeeded.length, failed: outcome.failed.length })
				: m['catalog.selection.delete_partial']({ deleted: outcome.succeeded.length, failed: outcome.failed.length });
		} else {
			bulkNotice = action === 'move'
				? m['catalog.selection.move_success']({ count: outcome.succeeded.length })
				: m['catalog.selection.delete_success']({ count: outcome.succeeded.length });
		}
	}
</script>

<section class="space-y-5" aria-labelledby="book-results-heading">
	<div class="flex flex-wrap items-end gap-4" class:justify-between={showHeading}>
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
			{#if showCoverSize}<BookDisplayPresets />{/if}
			{#if filterable}
				<ClearFiltersButton
					label={m['catalog.books.clear_filters']()}
					onclick={clearFilters}
					disabled={!selectedAuthor && !selectedSeries && !selectedTag && sort === 'title'}
				/>
			{/if}
			{#if canManageBooks}
				<button
					type="button"
					class={iconControlClass}
					aria-label={selecting ? m['catalog.books.exit_multi_select']() : m['catalog.books.multi_select']()}
					title={selecting ? m['catalog.books.exit_multi_select']() : m['catalog.books.multi_select']()}
					aria-pressed={selecting}
					onclick={toggleSelectionMode}
				>
					<Icon name="check" class={controlIconClass} />
				</button>
				{#if selecting && selectedBooks.length > 0}
					<BulkBookActions
						selected={selectedBooks}
						currentLibraryId={scope.library_id}
						disabled={loading || loadingMore}
						onfinished={finishBulk}
					/>
				{/if}
			{/if}
		</div>
	</div>

	{#if bulkNotice}
		<p class={bulkAlert
			? 'rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800'
			: 'rounded-md bg-emerald-50 p-3 text-sm text-emerald-900'} role={bulkAlert ? 'alert' : 'status'}>{bulkNotice}</p>
	{/if}

	{#if optionsLoading}
		<p use:showLoadingAfterDelay class="text-sm text-slate-600" role="status">{m['catalog.books.loading_filters']()}</p>
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
		<p use:showLoadingAfterDelay class="text-slate-600" role="status">{m['catalog.loading']()}</p>
	{:else if books.length === 0}
		<p class="card p-6 text-slate-600">{m['catalog.books.empty']()}</p>
	{:else}
		<ul class={mode === 'grid' ? 'book-grid book-grid-configurable' : 'space-y-3'} style={`--book-cover-size: ${bookDisplay.size}px; --book-cover-spacing: ${bookDisplay.spacing}px`}>
			{#each books as book (book.id)}
				{#snippet actions()}{@render bookActions?.(book)}{/snippet}
				<BookCard
					{book}
					{mode}
					actions={bookActions ? actions : undefined}
					selectable={canManageBooks && selecting}
					selected={selectedIDs.includes(book.id)}
					selectionLabel={m['catalog.books.select']({ title: book.title })}
					onselect={(selected) => toggleBook(book.id, selected)}
				/>
			{/each}
		</ul>
		{#if moreError}
			<div class="flex flex-wrap items-center gap-3 text-red-800" role="alert">
				<p>{moreError}</p>
				<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => staleMore ? (reloadVersion += 1) : loadMore()}>{m['catalog.retry']()}</button>
			</div>
		{/if}
		{#if hasNextPage(nextCursor)}
			<button
				class="button-primary rounded-md px-4 py-2 font-medium disabled:opacity-60"
				disabled={loadingMore}
				onclick={loadMore}
			>{loadingMore ? m['catalog.books.loading_more']() : m['catalog.books.load_more']()}</button>
		{:else}
			<p class="text-center text-sm text-slate-500" role="status">{m['catalog.books.end']()}</p>
		{/if}
	{/if}
</section>
