<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getBookState } from '#lib/reader/api.js';
	import { offlineStatus } from '#lib/sync/client.js';
	import { getBookContext } from '../book-context.svelte.js';
	import { BOOK_STATE_CHANGED_EVENT, type BookStateChangedDetail } from '../events.js';
	import { getReadingSummary, viewerTimezone, type ReadingSummary } from '../log-api.js';
	import { isUserBook, type UserBook } from '../user-book.js';
	import AttemptsCard from '../log/AttemptsCard.svelte';
	import LogSummary from '../log/LogSummary.svelte';
	import ProgressChart from '../log/ProgressChart.svelte';
	import RecordsCard from '../log/RecordsCard.svelte';
	import SessionsTable from '../log/SessionsTable.svelte';

	const context = getBookContext();
	const timezone = viewerTimezone();
	let summary = $state<ReadingSummary | null>(null);
	let userBook = $state<UserBook | null>(null);
	let loadedBookId = $state<number | null>(null);
	let loading = $state(true);
	let error = $state('');
	let retryNotice = $state('');
	let refreshVersion = $state(0);
	const offline = $derived(context.offline || !$offlineStatus.online);

	$effect(() => {
		if (!offline) retryNotice = '';
	});

	onMount(() => {
		const changed = (event: Event) => {
			const detail = (event as CustomEvent<BookStateChangedDetail>).detail;
			if (detail?.bookId === context.bookId) refreshVersion += 1;
		};
		window.addEventListener(BOOK_STATE_CHANGED_EVENT, changed);
		return () => window.removeEventListener(BOOK_STATE_CHANGED_EVENT, changed);
	});

	$effect(() => {
		const bookId = context.bookId;
		const disconnected = offline;
		refreshVersion;
		if (bookId === null || disconnected) return;
		const controller = new AbortController();
		untrack(() => void load(bookId, controller.signal));
		return () => controller.abort();
	});

	async function load(bookId: number, signal: AbortSignal) {
		if (loadedBookId !== bookId) {
			summary = null;
			userBook = null;
			loadedBookId = bookId;
		}
		loading = true;
		error = '';
		try {
			const [nextSummary, state] = await Promise.all([
				getReadingSummary(bookId, { timezone, signal }), getBookState(bookId)
			]);
			if (signal.aborted) return;
			if (state.user_book !== null && !isUserBook(state.user_book)) {
				throw new Error('Invalid user book in reading state.');
			}
			summary = nextSummary;
			userBook = isUserBook(state.user_book) ? state.user_book : null;
		} catch (cause) {
			if (signal.aborted) return;
			console.error('Could not load the reading log', cause);
			error = m['bv8.load_error']();
		} finally {
			if (!signal.aborted) loading = false;
		}
	}

	async function retry() {
		if (!navigator.onLine) {
			retryNotice = m['bv8.still_offline']();
			return;
		}
		retryNotice = '';
		if (context.offline) await context.reload();
		refreshVersion += 1;
	}
</script>

<section class="min-w-0 space-y-5" aria-labelledby="bv8-heading">
	<h1 id="bv8-heading" class="sr-only">{m['bv4.tabs.reading_log']()}</h1>
	{#if offline}
		<div class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-6 text-slate-600" role="status">
			<p>{m['bv8.offline']()}</p>
			<button type="button" class="font-medium text-emerald-700 underline underline-offset-4 focus-visible:outline-2" onclick={retry}>{m['bv8.retry']()}</button>
			{#if retryNotice}<p>{retryNotice}</p>{/if}
		</div>
	{:else}
		{#if error}
			<div class="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
				<p>{error}</p>
				<button type="button" class="font-medium underline underline-offset-4 focus-visible:outline-2" onclick={retry}>{m['bv8.retry']()}</button>
			</div>
		{/if}
		{#if context.book && summary && loadedBookId === context.book.id}
			{#key context.book.id}
				<div class="grid min-w-0 gap-5 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_18rem]">
					<LogSummary bookId={context.book.id} {summary} {userBook} />
					<SessionsTable bookId={context.book.id} title={context.book.title} {timezone} {refreshVersion} />
					<div class="grid min-w-0 gap-5 sm:grid-cols-2 lg:col-span-2 xl:col-span-1 xl:grid-cols-1 xl:content-start">
						<AttemptsCard attempts={summary.attempts} />
						<RecordsCard {summary} />
					</div>
				</div>
				<ProgressChart {summary} />
			{/key}
		{:else if loading && !error}
			<p class="rounded-2xl border border-slate-200 bg-white p-6 text-slate-600" role="status">{m['bv8.loading']()}</p>
		{/if}
	{/if}
</section>
