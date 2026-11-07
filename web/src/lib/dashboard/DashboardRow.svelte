<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ApiError } from '#lib/api/client.js';
	import { holdBookStateBatch } from '#lib/bookview/book-states.svelte.js';
	import { BOOK_STATE_CHANGED_EVENT } from '#lib/bookview/events.js';
	import BookCard from '#lib/catalog/BookCard.svelte';
	import type { Book } from '#lib/catalog/types.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { getShelf, listShelfBooks } from '#lib/shelves/api.js';
	import type { Shelf } from '#lib/shelves/types.js';
	import { DASHBOARD_PAGE_SIZE, listDashboardBooks, uniquePages } from './api.js';
	import { sectionLabel, type ShelfState } from './labels.js';
	import { isBuiltInSection, shelfId, type SectionId } from './layout.js';

	interface Props {
		id: SectionId;
		removing: boolean;
		onShelfState: (id: SectionId, state: ShelfState) => void;
		onRemove: (id: SectionId) => void;
	}

	let { id, removing, onShelfState, onRemove }: Props = $props();
	const pager = new CursorPager<Book>();
	let panel = $state<HTMLElement | null>(null);
	let scroller = $state<HTMLDivElement | null>(null);
	let shelfState = $state<ShelfState | undefined>(undefined);
	let shelfMode: Shelf['mode'] | undefined;
	let started = $state(false);
	let requestVersion = 0;
	const label = $derived(sectionLabel(id, shelfState));
	const headingId = $derived(`dashboard-${id.replace(':', '-')}`);

	onMount(() => {
		const begin = () => {
			if (started) return;
			started = true;
			void load();
		};
		let observer: IntersectionObserver | null = null;
		if (panel && typeof IntersectionObserver !== 'undefined') {
			observer = new IntersectionObserver((entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					observer?.disconnect();
					begin();
				}
			}, { rootMargin: '400px' });
			observer.observe(panel);
		} else {
			begin();
		}
		const refreshShelf = () => { if (started && shelfId(id) !== null) void load(); };
		const refreshBookState = () => {
			if (!started || !navigator.onLine) return;
			if ((isBuiltInSection(id) && id !== 'recently_added') ||
				shelfMode === 'automatic') void load();
		};
		const reconnect = () => { if (started) void load(); };
		const visible = () => { if (!document.hidden) refreshShelf(); };
		window.addEventListener('pandalibrary-shelves-changed', refreshShelf);
		window.addEventListener(BOOK_STATE_CHANGED_EVENT, refreshBookState);
		window.addEventListener('online', reconnect);
		document.addEventListener('visibilitychange', visible);
		return () => {
			requestVersion += 1;
			observer?.disconnect();
			pager.dispose();
			window.removeEventListener('pandalibrary-shelves-changed', refreshShelf);
			window.removeEventListener(BOOK_STATE_CHANGED_EVENT, refreshBookState);
			window.removeEventListener('online', reconnect);
			document.removeEventListener('visibilitychange', visible);
		};
	});

	function unavailable(error: unknown): boolean {
		return error instanceof ApiError && (error.status === 403 || error.status === 404);
	}

	function updateShelf(state: ShelfState) {
		shelfState = state;
		onShelfState(id, state);
	}

	async function load() {
		const releaseBatch = holdBookStateBatch();
		try {
			await loadPage();
		} finally {
			try {
				await tick();
			} finally {
				releaseBatch();
			}
		}
	}

	async function loadPage() {
		const version = ++requestVersion;
		void pager.reset(null);
		const numericId = shelfId(id);
		if (numericId !== null) {
			updateShelf({ status: 'loading' });
			let shelf: Shelf;
			try {
				shelf = await getShelf(numericId);
			} catch (error) {
				if (version !== requestVersion) return;
				console.error('Could not load dashboard shelf', error);
				updateShelf({ status: unavailable(error) ? 'unavailable' : 'error' });
				return;
			}
			if (version !== requestVersion) return;
			shelfMode = shelf.mode;
			await pager.reset(uniquePages((cursor, signal) =>
				listShelfBooks(numericId, { cursor, signal, limit: DASHBOARD_PAGE_SIZE })
			));
			if (version !== requestVersion) return;
			if (pager.status === 'error') {
				console.error('Could not load dashboard shelf books', pager.error);
				updateShelf({ status: unavailable(pager.error) ? 'unavailable' : 'error' });
			} else {
				updateShelf({ status: 'ready', shelf });
			}
		} else if (isBuiltInSection(id)) {
			await pager.reset(uniquePages((cursor, signal) =>
				listDashboardBooks(id, { cursor, signal })
			));
			if (version === requestVersion && pager.status === 'error') {
				console.error('Could not load dashboard section', pager.error);
			}
		}
	}

	async function loadMore() {
		const version = requestVersion;
		await pager.loadMore();
		if (version !== requestVersion || !pager.moreError) return;
		console.error('Could not load more dashboard books', pager.moreError);
		if (shelfId(id) !== null && unavailable(pager.moreError)) {
			void pager.reset(null);
			updateShelf({ status: 'unavailable' });
		}
	}

	function scroll(direction: -1 | 1) {
		if (scroller) scroller.scrollBy({ left: direction * scroller.clientWidth * 0.8, behavior: 'smooth' });
	}
</script>

<section
	bind:this={panel}
	aria-labelledby={headingId}
	class="min-w-0 space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
	data-dashboard-section={id}
>
	<div class="flex flex-wrap items-center justify-between gap-3">
		<h2 id={headingId} class="text-xl font-semibold tracking-tight text-slate-900">
			<span class="mr-2 inline-block h-5 w-1 rounded-full bg-emerald-500 align-middle" aria-hidden="true"></span>{label}
		</h2>
		{#if pager.items.length && shelfState?.status !== 'unavailable'}
			<div class="flex gap-2">
				<button class="rounded-md border border-slate-300 px-3 py-1 text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-emerald-700" aria-label={m['ux5.scroll_previous']({ section: label })} onclick={() => scroll(-1)}>&larr;</button>
				<button class="rounded-md border border-slate-300 px-3 py-1 text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-emerald-700" aria-label={m['ux5.scroll_next']({ section: label })} onclick={() => scroll(1)}>&rarr;</button>
			</div>
		{/if}
	</div>

	{#if shelfState?.status === 'unavailable'}
		<div class="space-y-2 text-sm text-slate-700" role="status">
			<p>{m['ux5.unavailable_detail']()}</p>
			<button class="font-medium text-emerald-800 underline focus-visible:outline-2 disabled:opacity-50" disabled={removing} onclick={() => onRemove(id)}>{m['ux5.remove_unavailable']()}</button>
		</div>
	{:else if shelfState?.status === 'error' || pager.status === 'error'}
		<div class="space-y-2 text-sm text-red-800" role="alert">
			<p>{m['ux5.feed_failed']()}</p>
			<button class="font-medium underline focus-visible:outline-2" onclick={() => void load()}>{m['ux5.retry']()}</button>
		</div>
	{:else if !started || shelfState?.status === 'loading' || pager.status === 'idle' || pager.status === 'loading'}
		<p class="text-sm text-slate-600" role="status">{m['ux5.feed_loading']()}</p>
	{:else}
		{#if pager.items.length}
			<div bind:this={scroller} class="min-w-0 overflow-x-auto pb-2" role="region" aria-label={m['ux5.cover_row']({ section: label })}>
				<ul class="flex gap-5 pt-1 pb-3 [&>li]:w-36 [&>li]:shrink-0 sm:[&>li]:w-book">
					{#each pager.items as book (book.id)}
						<BookCard {book} />
					{/each}
				</ul>
			</div>
		{:else if pager.hasMore}
			<p class="text-sm text-slate-600">{m['ux5.feed_empty_page']()}</p>
		{:else}
			<p class="text-sm text-slate-600">{m['ux5.feed_empty']()}</p>
		{/if}
		{#if pager.moreError}
			<div class="flex flex-wrap items-center gap-3 text-sm text-red-800" role="alert">
				<p>{m['ux5.more_failed']()}</p>
				<button class="font-medium underline focus-visible:outline-2" onclick={() => void load()}>{m['ux5.reload_feed']()}</button>
			</div>
		{/if}
		{#if pager.hasMore}
			<button class="rounded-md border border-emerald-700 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60" disabled={pager.loadingMore} onclick={() => void loadMore()}>
				{pager.loadingMore ? m['ux5.loading_more']() : m['ux5.load_more']()}
			</button>
		{/if}
	{/if}
</section>
