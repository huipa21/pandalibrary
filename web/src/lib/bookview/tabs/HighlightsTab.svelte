<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { requestNotesExport, saveBlob } from '#lib/notes/export.js';
	import { getBookState } from '#lib/reader/api.js';
	import type { BookState, Highlight, HighlightStyle, Note } from '#lib/reader/types.js';
	import AnnotationEntry from '#lib/notes/AnnotationEntry.svelte';
	import KindFilter from '#lib/notes/KindFilter.svelte';
	import { annotationKindFilter } from '#lib/notes/entry.js';
	import { currentAccount, offlineAvailable } from '#lib/sync/client.js';
	import { readerState } from '#lib/sync/state.js';
	import { getBookContext } from '../book-context.svelte.js';
	import { BOOK_STATE_CHANGED_EVENT, type BookStateChangedDetail } from '../events.js';
	import { listReviews } from '../reviews-api.js';
	import { filterBookAnnotations, otherBookAnnotations, type BookAnnotation } from '../highlights/book-annotations.js';
	import HighlightList from '../highlights/HighlightList.svelte';
	import HighlightsSidebar from '../highlights/HighlightsSidebar.svelte';
	import HighlightsToolbar from '../highlights/HighlightsToolbar.svelte';
	import {
		buildMarks,
		chapterKey,
		colorCounts,
		filterMarks,
		groupByChapter,
		markStats,
		parseMarkSort,
		sortMarks,
		type MarkSort
	} from '../highlights/highlights-model.js';

	const COMPACT_KEY = 'pandalibrary.bookview.highlights.compact';
	const context = getBookContext();
	const locale = $derived(getLocale());

	let highlights = $state<Highlight[]>([]);
	let notes = $state<Note[]>([]);
	let otherAnnotations = $state<BookAnnotation[]>([]);
	let reviewsOffline = $state(false);
	let reviewsError = $state(false);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let notesOnly = $state(false);
	let colors = $state<ReadonlySet<string>>(new Set());
	let styles = $state<ReadonlySet<HighlightStyle>>(new Set());
	let compact = $state(false);
	let compactLoaded = $state(false);
	let online = $state(true);
	let exporting = $state(false);
	let exportMessage = $state('');
	let exportError = $state('');
	let now = $state(new Date());
	let requestVersion = 0;

	const bookId = $derived(context.bookId);
	const book = $derived(context.book);
	const files = $derived(book?.files ?? []);
	const query = $derived((page.url.searchParams.get('q') ?? '').trim());
	const sort = $derived(parseMarkSort(page.url.searchParams.get('sort')));
	const kind = $derived(annotationKindFilter(page.url.searchParams.get('kind')));
	const untitled = $derived(m['bv9.untitled']());

	const marks = $derived(buildMarks(highlights, notes));
	const readingOrder = $derived(sortMarks(marks, 'reading'));
	const allChapters = $derived(groupByChapter(readingOrder, untitled));
	const chapterIds = $derived(new Map(allChapters.map((group, index) => [chapterKey(group), `highlights-chapter-${index}`])));
	const stats = $derived(markStats(marks, now, files, otherAnnotations));
	const total = $derived(marks.length + otherAnnotations.length);
	const notesCount = $derived(marks.filter((mark) => mark.notes.length > 0).length + otherAnnotations.filter((item) => item.kind === 'book_note' || item.kind === 'comment').length);
	const colorOptions = $derived(colorCounts(marks));
	const visible = $derived(sortMarks(filterMarks(marks, { query, colors, styles, notesOnly }).filter((mark) =>
		!kind || (kind === 'comment' ? mark.notes.length > 0 : kind === (mark.style ?? 'highlight'))
	), sort));
	const visibleOther = $derived(filterBookAnnotations(otherAnnotations, { query, kind, colors, styles, notesOnly, sort }));
	const shown = $derived(visible.length + visibleOther.length);
	const groups = $derived(groupByChapter(visible, untitled));
	const filtered = $derived(query !== '' || colors.size > 0 || styles.size > 0 || notesOnly || kind !== '');
	const offline = $derived(context.offline || !online);

	async function fetchState(id: number): Promise<BookState> {
		if (!offlineAvailable()) return getBookState(id);
		if (context.offline || !navigator.onLine) return (await readerState(currentAccount(), id)).state;
		try {
			const state = await getBookState(id);
			// Replays queued offline edits on top of the server state.
			return (await readerState(currentAccount(), id, { state, settings: [] })).state;
		} catch (cause) {
			if (cause instanceof TypeError) return (await readerState(currentAccount(), id)).state;
			throw cause;
		}
	}

	async function load(quiet = false) {
		const id = bookId;
		const currentBook = book;
		if (id === null || !currentBook) return;
		const version = ++requestVersion;
		if (!quiet) status = 'loading';
		try {
			const unavailable = context.offline || !navigator.onLine;
			const [state, reviews] = await Promise.all([
				fetchState(id),
				unavailable ? null : listReviews(id, { limit: 1 }).then(
					(result) => ({ status: 'ready' as const, result }),
					(cause: unknown) => ({ status: 'error' as const, cause })
				)
			]);
			if (version !== requestVersion) return;
			highlights = state.highlights.filter((row) => row.book_id === id);
			notes = state.notes.filter((row) => row.book_id === id);
			otherAnnotations = otherBookAnnotations(currentBook, state, reviews?.status === 'ready' ? reviews.result.mine : null);
			reviewsOffline = unavailable;
			reviewsError = reviews?.status === 'error';
			if (reviews?.status === 'error') console.error('Could not load book review', reviews.cause);
			now = new Date();
			status = 'ready';
		} catch (cause) {
			if (version !== requestVersion) return;
			console.error('Could not load book annotations', cause);
			// A failed background refresh keeps the list that is already shown.
			if (!quiet || status !== 'ready') status = 'error';
		}
	}

	$effect(() => {
		void bookId;
		void book;
		untrack(() => void load());
	});

	onMount(() => {
		try {
			compact = localStorage.getItem(COMPACT_KEY) === '1';
		} catch {
			compact = false;
		}
		compactLoaded = true;
		online = navigator.onLine;
		const onState = (event: Event) => {
			const detail = (event as CustomEvent<BookStateChangedDetail | null>).detail;
			if (detail?.bookId === bookId) void load(true);
		};
		const onFocus = () => void load(true);
		const onConnection = () => {
			online = navigator.onLine;
			void load(true);
		};
		window.addEventListener(BOOK_STATE_CHANGED_EVENT, onState);
		window.addEventListener('focus', onFocus);
		window.addEventListener('online', onConnection);
		window.addEventListener('offline', onConnection);
		return () => {
			window.removeEventListener(BOOK_STATE_CHANGED_EVENT, onState);
			window.removeEventListener('focus', onFocus);
			window.removeEventListener('online', onConnection);
			window.removeEventListener('offline', onConnection);
		};
	});

	$effect(() => {
		const value = compact;
		if (!compactLoaded) return;
		try {
			localStorage.setItem(COMPACT_KEY, value ? '1' : '0');
		} catch {
			// Storage can be unavailable; the toggle still applies to this visit.
		}
	});

	async function updateUrl(changes: Record<string, string | null>) {
		const url = new URL(page.url.href);
		for (const [key, value] of Object.entries(changes)) {
			if (value) url.searchParams.set(key, value);
			else url.searchParams.delete(key);
		}
		if (url.href === page.url.href) return;
		await goto(`${url.pathname}${url.search}${url.hash}`, { replace: true, reset: false });
	}

	function setQuery(next: string) {
		void updateUrl({ q: next || null });
	}

	function setSort(next: MarkSort) {
		void updateUrl({ sort: next === 'reading' ? null : next });
	}

	function toggleColor(color: string) {
		const next = new Set(colors);
		if (next.has(color)) next.delete(color);
		else next.add(color);
		colors = next;
	}

	async function clearFilters() {
		colors = new Set();
		styles = new Set();
		notesOnly = false;
		await updateUrl({ q: null, kind: null });
	}

	async function jumpToChapter(key: string) {
		const id = chapterIds.get(key);
		if (!id) return;
		if (!groups.some((group) => chapterKey(group) === key)) {
			await clearFilters();
			await tick();
		}
		const target = document.getElementById(id);
		if (!target) return;
		const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
		target.focus({ preventScroll: true });
	}

	async function exportHighlights() {
		if (bookId === null || exporting || offline) return;
		exporting = true;
		exportMessage = '';
		exportError = '';
		try {
			const result = await requestNotesExport([bookId]);
			saveBlob(result.blob, result.filename);
			exportMessage = m['bv9.export_done']({ filename: result.filename });
		} catch (cause) {
			console.error('Could not export highlights', cause);
			exportError = m['bv9.export_failed']();
		} finally {
			exporting = false;
		}
	}
</script>

{#if book && bookId !== null}
	<section aria-labelledby="highlights-heading" class="space-y-4">
		<h1 id="highlights-heading" class="sr-only">{m['bv9.heading']({ title: book.title })}</h1>

		{#if status === 'loading'}
			<p class="text-slate-600" role="status">{m['bv9.loading']()}</p>
		{:else if status === 'error'}
			<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
				<p>{m['bv9.error']()}</p>
				<button type="button" class="underline underline-offset-4 focus-visible:outline-2" onclick={() => load()}>{m['bv9.retry']()}</button>
			</div>
		{:else if total === 0}
			<p class="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-600" role="status">{m['bv9.empty']()}</p>
		{:else}
			<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
				<div class="lg:order-2">
					<HighlightsSidebar
						{stats}
						chapters={allChapters}
						{colors}
						onToggleColor={toggleColor}
						onJump={jumpToChapter}
						{locale}
					/>
				</div>
				<div class="min-w-0 space-y-4 lg:order-1">
					<KindFilter value={kind} onchange={(next) => updateUrl({ kind: next || null })} />
					<HighlightsToolbar
						{query}
						onQuery={setQuery}
						{notesCount}
						bind:notesOnly
						{sort}
						onSort={setSort}
						{colorOptions}
						{colors}
						onToggleColor={toggleColor}
						{styles}
						onToggleStyle={(style) => {
							const next = new Set(styles);
							if (next.has(style)) next.delete(style);
							else next.add(style);
							styles = next;
						}}
						bind:compact
						{offline}
						{exporting}
						onExport={exportHighlights}
					/>
					{#if exportMessage}
						<p class="text-sm text-emerald-700" role="status">{exportMessage}</p>
					{/if}
					{#if exportError}
						<p class="text-sm text-red-700" role="alert">{exportError}</p>
					{/if}
					{#if filtered}
						<p class="text-sm text-slate-600" role="status">{m['bv9.showing']({ shown, total })}</p>
					{/if}
					{#if shown === 0}
						<div class="space-y-3 rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-600">
							<p>{m['bv9.no_match']()}</p>
							<button
								type="button"
								class="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
								onclick={clearFilters}
							>
								{m['bv9.clear_filters']()}
							</button>
						</div>
					{:else if visible.length > 0}
						<div class="card px-4 py-5 sm:px-6">
							<HighlightList {groups} {chapterIds} {bookId} {files} {query} {compact} {locale} />
						</div>
					{/if}
					{#if visibleOther.length > 0}
						<ol class="card divide-y divide-slate-200 px-4 sm:px-6" aria-label={m['notes.title']()}>
							{#each visibleOther as item (`${item.kind}:${item.id}`)}
								<li><AnnotationEntry {item} /></li>
							{/each}
						</ol>
					{/if}
				</div>
			</div>
		{/if}
		{#if status === 'ready' && reviewsOffline}
			<p class="text-sm text-slate-600" role="status">{m['bv9.reviews_offline']()}</p>
		{/if}
		{#if status === 'ready' && reviewsError}
			<div class="flex flex-wrap items-center gap-3 text-sm text-red-700" role="alert">
				<p>{m['bv9.reviews_error']()}</p>
				<button type="button" class="underline underline-offset-4 focus-visible:outline-2" onclick={() => load(true)}>{m['bv9.retry']()}</button>
			</div>
		{/if}
	</section>
{/if}
