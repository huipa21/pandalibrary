<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import { BoundedPoller } from '#lib/admin/poller.js';
	import { focusRing, primaryButton, dangerButton, linkClass } from '#lib/admin/ui.js';
	import ClearFiltersButton from '#lib/catalog/ClearFiltersButton.svelte';
	import ViewToggle from '#lib/catalog/ViewToggle.svelte';
	import { filterControlClass } from '#lib/catalog/filter-styles.js';
	import SearchField from '#lib/search/SearchField.svelte';
	import AssignDialog from './AssignDialog.svelte';
	import DeleteDialog from './DeleteDialog.svelte';
	import HeapItemRow from './HeapItemRow.svelte';
	import HeapItemTile from './HeapItemTile.svelte';
	import ScanControl from './ScanControl.svelte';
	import ScanStatus from './ScanStatus.svelte';
	import { BOOKHEAP_CHANGED_EVENT, notifyBookheapChanged } from './events.js';
	import { HeapList } from './heap-list.svelte.js';
	import {
		EMPTY_HEAP_QUERY,
		fetchHeapPage,
		heapQueryFromSearch,
		heapQueryKey,
		heapQueryToSearch,
		isFiltered,
		isHeapStatusFilter,
		MAX_HEAP_QUERY_LENGTH,
		type HeapQuery,
		type HeapStatusFilter
	} from './query.js';
	import { heapErrorKey, type BulkOutcome } from './results.js';
	import { ScanController } from './scan.svelte.js';
	import { HeapSelection, isActive, MAX_SELECTION } from './selection.svelte.js';
	import type { HeapItem } from './types.js';

	const SEARCH_DEBOUNCE_MS = 300;
	const SHELVES_CHANGED_EVENT = 'pandalibrary-shelves-changed';
	const VIEW_KEY = 'pandalibrary.bookheap.view';

	const list = new HeapList();
	const selection = new HeapSelection();
	const scan = new ScanController({ onfinish: () => notifyBookheapChanged() });
	// Follows queued/importing items until they settle; ~10 minutes per start.
	const livePoller = new BoundedPoller(
		async () => {
			await refreshList();
			return list.hasActive;
		},
		{ intervalMs: 3000, maxTicks: 200 }
	);

	const query = $derived(heapQueryFromSearch(page.url.searchParams));
	const queryKey = $derived(heapQueryKey(query));
	const filtered = $derived(isFiltered(query));
	const pageState = $derived(selection.pageState(list.items));

	let searchText = $state(heapQueryFromSearch(page.url.searchParams).q);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	let assignOpen = $state(false);
	let deleteOpen = $state(false);
	let dialogItems = $state<HeapItem[]>([]);
	let notice = $state('');
	let capNotice = $state('');
	let navigationError = $state('');
	let pageCheckbox = $state<HTMLInputElement | null>(null);
	let view = $state<'grid' | 'list'>('grid');
	let viewError = $state('');

	const statusOptions: { value: HeapStatusFilter; label: () => string }[] = [
		{ value: '', label: m['bh4.filter.all'] },
		{ value: 'ready', label: m['bh4.status.ready'] },
		{ value: 'duplicate', label: m['bh4.status.duplicate'] },
		{ value: 'invalid', label: m['bh4.status.invalid'] },
		{ value: 'active', label: m['bh4.filter.active'] },
		{ value: 'failed', label: m['bh4.status.failed'] }
	];

	// A filter change resets paging and selection.
	$effect(() => {
		void queryKey;
		untrack(() => {
			const current = query;
			selection.clear();
			capNotice = '';
			notice = '';
			if (searchTimer === null && searchText.trim() !== current.q) searchText = current.q;
			void list.reset((cursor, signal) => fetchHeapPage(current, cursor, signal));
		});
	});

	$effect(() => {
		if (pageCheckbox) pageCheckbox.indeterminate = pageState === 'some';
	});

	$effect(() => {
		if (list.status === 'ready' && list.hasActive && !livePoller.active) livePoller.start();
	});

	onMount(() => {
		try {
			const saved = localStorage.getItem(VIEW_KEY);
			if (saved === 'grid' || saved === 'list') view = saved;
		} catch (cause) {
			console.error('Could not load Bookheap view preference', cause);
			viewError = m['bc5.view.load_error']();
		}
		void scan.attach();
		const changed = () => void refreshList();
		window.addEventListener(BOOKHEAP_CHANGED_EVENT, changed);
		return () => {
			window.removeEventListener(BOOKHEAP_CHANGED_EVENT, changed);
			if (searchTimer !== null) clearTimeout(searchTimer);
			livePoller.stop();
			scan.dispose();
			list.dispose();
		};
	});

	function changeView(next: 'grid' | 'list') {
		view = next;
		viewError = '';
		try {
			localStorage.setItem(VIEW_KEY, next);
		} catch (cause) {
			console.error('Could not save Bookheap view preference', cause);
			viewError = m['bc5.view.save_error']();
		}
	}

	/** Re-reads the shown pages, keeps the selection in step, and reports imported shelf members. */
	async function refreshList() {
		const shelved = list.items.filter((item) => isActive(item) && item.target_shelf_ids.length > 0).map((item) => item.id);
		const complete = await list.refresh();
		if (list.status !== 'ready') return;
		selection.sync(list.items, complete);
		const listed = new Set(list.items.map((item) => item.id));
		if (shelved.some((id) => !listed.has(id))) window.dispatchEvent(new CustomEvent(SHELVES_CHANGED_EVENT));
	}

	async function changeQuery(next: HeapQuery) {
		if (heapQueryKey(next) === queryKey) return;
		const params = heapQueryToSearch(next, page.url.searchParams);
		const search = params.toString();
		navigationError = '';
		try {
			await goto(`${page.url.pathname}${search ? `?${search}` : ''}`, { replace: true, reset: false });
		} catch {
			navigationError = m['bh4.error.navigation']();
		}
	}

	function onSearchInput() {
		if (searchTimer !== null) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			searchTimer = null;
			void changeQuery({ status: query.status, q: searchText });
		}, SEARCH_DEBOUNCE_MS);
	}

	function submitSearch(event: SubmitEvent) {
		event.preventDefault();
		if (searchTimer !== null) clearTimeout(searchTimer);
		searchTimer = null;
		void changeQuery({ status: query.status, q: searchText });
	}

	function changeStatus(value: string) {
		if (isHeapStatusFilter(value)) void changeQuery({ status: value, q: query.q });
	}

	function clearFilters() {
		if (searchTimer !== null) clearTimeout(searchTimer);
		searchTimer = null;
		searchText = '';
		void changeQuery(EMPTY_HEAP_QUERY);
	}

	function toggleItem(item: HeapItem) {
		capNotice = selection.toggle(item) ? '' : m['bh4.selection.cap']({ max: MAX_SELECTION });
	}

	function togglePage() {
		const refused = selection.togglePage(list.items);
		capNotice = refused > 0 ? m['bh4.selection.cap']({ max: MAX_SELECTION }) : '';
	}

	function clearSelection() {
		selection.clear();
		capNotice = '';
	}

	function openAssign() {
		if (assignOpen || deleteOpen || selection.size === 0) return;
		dialogItems = selection.items;
		notice = '';
		assignOpen = true;
	}

	function openDelete() {
		if (assignOpen || deleteOpen || selection.size === 0) return;
		dialogItems = selection.items;
		notice = '';
		deleteOpen = true;
	}

	function assigned(outcome: BulkOutcome) {
		selection.remove(outcome.succeeded);
		if (outcome.succeeded.length > 0) notice = m['bh4.assign.queued']({ count: outcome.succeeded.length });
		notifyBookheapChanged();
	}

	function deleted(outcome: BulkOutcome) {
		selection.remove(outcome.succeeded);
		if (outcome.succeeded.length > 0) notice = m['bh4.delete.done']({ count: outcome.succeeded.length });
		notifyBookheapChanged();
	}
</script>

<div class="space-y-6 pb-20">
	<div>
		<form class="flex flex-wrap items-end gap-3" role="search" onsubmit={submitSearch}>
			<label class="grid gap-1 text-sm font-medium">
				<span>{m['bh4.filter.status']()}</span>
				<select class="{filterControlClass} min-w-40" value={query.status} onchange={(event) => changeStatus(event.currentTarget.value)}>
					{#each statusOptions as option (option.value)}
						<option value={option.value}>{option.label()}</option>
					{/each}
				</select>
			</label>
			<SearchField
				class="min-w-52 flex-1 sm:max-w-sm"
				label={m['bh4.filter.search']()}
				maxlength={MAX_HEAP_QUERY_LENGTH}
				placeholder={m['bh4.filter.search_placeholder']()}
				bind:value={searchText}
				oninput={onSearchInput}
			/>
			<ScanControl controller={scan} />
			<ViewToggle {view} onchange={changeView} />
			{#if filtered}
				<ClearFiltersButton label={m['bh4.filter.clear']()} onclick={clearFilters} />
			{/if}
		</form>
		<ScanStatus controller={scan} />
	</div>

	{#if viewError}<p class="text-sm text-red-800" role="alert">{viewError}</p>{/if}
	{#if navigationError}<p class="text-sm text-red-800" role="alert">{navigationError}</p>{/if}
	{#if notice}<p class="text-sm text-emerald-800" role="status" data-testid="bh4-notice">{notice}</p>{/if}

	{#if list.status === 'loading' || list.status === 'idle'}
		<p class="text-slate-600" role="status">{m['bh4.list.loading']()}</p>
	{:else if list.status === 'error'}
		<AdminAlert message={translate(heapErrorKey(list.error, 'load'))} error={list.error} onretry={() => list.retry()} />
	{:else if list.empty && !filtered}
		<section class="space-y-3 rounded-lg border border-dashed border-slate-300 bg-white p-6" aria-labelledby="bh4-empty-heading">
			<h2 id="bh4-empty-heading" class="text-lg font-semibold">{m['bh4.empty.title']()}</h2>
			<p class="text-slate-700">{m['bh4.empty.upload']()}</p>
			<p class="text-slate-700">{m['bh4.empty.scan']()}</p>
		</section>
	{:else if list.empty}
		<div class="space-y-3 card p-6">
			<p class="text-slate-700">{m['bh4.list.no_matches']()}</p>
			<button type="button" class={linkClass} onclick={clearFilters}>{m['bh4.filter.clear']()}</button>
		</div>
	{:else}
		<section class="space-y-3" aria-labelledby="bh4-list-heading">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<label class="flex items-center gap-2 text-sm">
					<input
						bind:this={pageCheckbox}
						type="checkbox"
						class={`size-4 ${focusRing}`}
						checked={pageState === 'all'}
						onchange={togglePage}
					/>
					<span>{m['bh4.list.select_page']()}</span>
				</label>
				<h2 id="bh4-list-heading" class="text-sm text-slate-600" data-testid="bh4-total">
					{m['bh4.list.total']({ count: list.total ?? list.items.length })}
					{#if list.refreshing}<span class="ml-2 text-slate-500">{m['bh4.list.updating']()}</span>{/if}
				</h2>
			</div>
			<ul class={view === 'grid' ? 'book-grid' : 'space-y-2'} aria-label={m['bh4.list.label']()}>
				{#each list.items as item (item.id)}
					{#if view === 'grid'}
						<HeapItemTile {item} selected={selection.has(item.id)} ontoggle={toggleItem} />
					{:else}
						<HeapItemRow {item} selected={selection.has(item.id)} ontoggle={toggleItem} />
					{/if}
				{/each}
			</ul>
			{#if list.moreError}
				{#if heapErrorKey(list.moreError, 'more') === 'admin.error.stale_cursor'}
					<AdminAlert message={m['admin.error.stale_cursor']()} onretry={() => list.retry()} retryLabel={m['admin.restart_list']()} />
				{:else}
					<AdminAlert message={translate(heapErrorKey(list.moreError, 'more'))} error={list.moreError} onretry={() => list.loadMore()} />
				{/if}
			{/if}
			{#if list.hasMore}
				<button type="button" class={primaryButton} disabled={list.loadingMore || list.refreshing} onclick={() => list.loadMore()}>
					{list.loadingMore ? m['admin.loading_more']() : m['bh4.list.load_more']()}
				</button>
			{:else if list.ended}
				<p class="text-sm text-slate-500">{m['admin.list_end']()}</p>
			{/if}
		</section>
	{/if}
</div>

{#if selection.size > 0 || capNotice}
	<div
		class="sticky bottom-2 z-20 -mx-1 flex flex-wrap items-center gap-3 rounded-lg border border-slate-300 bg-white/95 p-3 shadow-lg backdrop-blur"
		role="region"
		aria-label={m['bh4.selection.label']()}
		data-testid="bh4-bulk-bar"
	>
		<p class="text-sm font-medium" aria-live="polite" data-testid="bh4-selected-count">{m['bh4.selection.count']({ count: selection.size })}</p>
		{#if selection.size > 0}
			<button type="button" class={`text-sm underline underline-offset-4 ${focusRing}`} onclick={clearSelection}>{m['bh4.selection.clear']()}</button>
			<div class="ml-auto flex flex-wrap gap-2">
				<button type="button" class={primaryButton} aria-haspopup="dialog" disabled={assignOpen || deleteOpen} onclick={openAssign}>{m['bh4.assign.open']()}</button>
				<button type="button" class={dangerButton} aria-haspopup="dialog" disabled={assignOpen || deleteOpen} onclick={openDelete}>{m['bh4.delete.open']()}</button>
			</div>
		{/if}
		{#if capNotice}<p class="basis-full text-sm text-amber-900" role="status">{capNotice}</p>{/if}
	</div>
{/if}

<AssignDialog open={assignOpen} items={dialogItems} onclose={() => (assignOpen = false)} onassigned={assigned} />
<DeleteDialog open={deleteOpen} items={dialogItems} onclose={() => (deleteOpen = false)} ondeleted={deleted} />
