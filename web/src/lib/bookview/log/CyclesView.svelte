<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { offlineStatus } from '#lib/sync/client.js';
	import Icon from '../Icon.svelte';
	import { getBookContext } from '../book-context.svelte.js';
	import { BOOK_STATE_CHANGED_EVENT, type BookStateChangedDetail } from '../events.js';
	import { formatDate, formatDuration, formatPercent } from '../format.js';
	import { getReadingSummary, listBookSessions, viewerTimezone, type BookSession } from '../log-api.js';
	import { attemptMarkerClass, attemptTitle } from './cycle-labels.js';
	import { buildCycleDetails, collectAllSessions, cyclesOverview, type CycleDetail } from './cycles-model.js';
	import { changeTone } from './log-model.js';

	const context = getBookContext();
	const timezone = viewerTimezone();
	const locale = $derived(getLocale());
	let cycles = $state<CycleDetail[] | null>(null);
	let loadedBookId = $state<number | null>(null);
	let loading = $state(true);
	let error = $state('');
	let retryNotice = $state('');
	let refreshVersion = $state(0);
	const offline = $derived(context.offline || !$offlineStatus.online);
	const overview = $derived(cycles ? cyclesOverview(cycles, timezone) : null);
	const dateFormatter = $derived(new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'medium' }));
	const timeFormatter = $derived(new Intl.DateTimeFormat(locale, { timeZone: timezone, timeStyle: 'short' }));
	const signedPercent = $derived(new Intl.NumberFormat(locale, { style: 'percent', signDisplay: 'always', maximumFractionDigits: 1 }));

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
			cycles = null;
			loadedBookId = bookId;
		}
		loading = true;
		error = '';
		try {
			const [summary, sessions] = await Promise.all([
				getReadingSummary(bookId, { timezone, signal }),
				collectAllSessions((cursor) => listBookSessions(bookId, { range: 'all', cursor, limit: 100, timezone, signal }))
			]);
			if (signal.aborted) return;
			cycles = buildCycleDetails(summary.attempts, sessions, timezone);
		} catch (cause) {
			if (signal.aborted) return;
			console.error('Could not load the reading cycles', cause);
			error = m['bv8.cycles_error']();
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

	function formatChange(change: number | null): string {
		if (change === null) return m['bv8.no_data']();
		return change === 0 ? formatPercent(0, locale) : signedPercent.format(change);
	}

	function position(session: BookSession): string {
		if (session.start_percentage === null || session.end_percentage === null) return m['bv8.no_data']();
		return m['bv8.position_range']({
			start: formatPercent(session.start_percentage, locale), end: formatPercent(session.end_percentage, locale)
		});
	}
</script>

<section class="min-w-0 space-y-5" aria-labelledby="bv8-cycles-heading">
	<div class="flex flex-wrap items-center gap-3">
		<a href={`/books/${context.bookId}/activities`}
			class="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-emerald-700 hover:underline focus-visible:outline-2 focus-visible:outline-emerald-700 underline-offset-4">
			<Icon name="arrow-left" class="size-4" /> {m['bv8.cycles_back']()}
		</a>
	</div>
	<h1 id="bv8-cycles-heading" class="text-lg font-semibold text-slate-900">{m['bv8.cycles_title']()}</h1>
	{#if offline}
		<div class="card space-y-3 p-6 text-slate-600" role="status">
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
		{#if cycles && overview && loadedBookId === context.bookId}
			{#if cycles.length === 0}
				<p class="card p-6 text-sm text-slate-500">{m['bv8.cycles_empty']()}</p>
			{:else}
				<section class="card p-5" aria-labelledby="bv8-cycles-overview">
					<h2 id="bv8-cycles-overview" class="text-xs font-semibold uppercase tracking-wider text-slate-500">{m['bv8.cycles_overview']()}</h2>
					<dl class="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
						{#each [
							[m['bv8.cycles_total'](), String(overview.cycles)],
							[m['bv8.cycles_completed'](), String(overview.completed)],
							[m['bv8.total_time'](), formatDuration(overview.totalSeconds)],
							[m['bv8.sessions'](), String(overview.sessions)],
							[m['bv8.average_session'](), formatDuration(overview.averageSeconds)],
							[m['bv8.active_days'](), String(overview.activeDays)],
							[m['bv8.cycles_best_progress'](), overview.bestProgress === null ? m['bv8.no_data']() : formatPercent(overview.bestProgress, locale)]
						] as [label, value] (label)}
							<div>
								<dt class="text-xs text-slate-500">{label}</dt>
								<dd class="mt-1 text-lg font-semibold text-slate-900">{value}</dd>
							</div>
						{/each}
					</dl>
				</section>
				<ol class="space-y-5">
					{#each cycles as cycle (cycle.attempt.number)}
						{@const attempt = cycle.attempt}
						<li>
							<section class="min-w-0 overflow-hidden card" aria-labelledby={`bv8-cycle-${attempt.number}`}>
								<div class="space-y-4 p-5">
									<div class="flex flex-wrap items-baseline justify-between gap-2">
										<h2 id={`bv8-cycle-${attempt.number}`} class="flex items-center gap-2 text-sm font-semibold text-slate-800">
											<span aria-hidden="true" class={`size-2.5 rounded-full border-2 ${attemptMarkerClass(attempt.status)}`}></span>
											{attemptTitle(attempt)}
										</h2>
										<p class="text-xs text-slate-500">{m['bv8.attempt_range']({ start: formatDate(attempt.started_at, locale), end: formatDate(attempt.ended_at, locale) })}</p>
									</div>
									<dl class="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 xl:grid-cols-6">
										<div><dt class="text-xs text-slate-500">{m['bv8.sessions']()}</dt><dd class="mt-1 font-semibold text-slate-900">{attempt.sessions}</dd></div>
										<div><dt class="text-xs text-slate-500">{m['bv8.total_time']()}</dt><dd class="mt-1 font-semibold text-slate-900">{formatDuration(attempt.seconds)}</dd></div>
										<div><dt class="text-xs text-slate-500">{m['bv8.average_session']()}</dt><dd class="mt-1 font-semibold text-slate-900">{formatDuration(cycle.averageSeconds)}</dd></div>
										<div><dt class="text-xs text-slate-500">{m['bv8.cycle_progress']()}</dt><dd class="mt-1 font-semibold text-slate-900">{attempt.max_percentage === null ? m['bv8.no_data']() : formatPercent(attempt.max_percentage, locale)}</dd></div>
										<div><dt class="text-xs text-slate-500">{m['bv8.active_days']()}</dt><dd class="mt-1 font-semibold text-slate-900">{cycle.activeDays}</dd></div>
										<div>
											<dt class="text-xs text-slate-500">{m['bv8.cycle_sources']()}</dt>
											<dd class="mt-1 flex flex-wrap gap-1">
												{#each attempt.sources as source (source)}
													<span class="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600">{source.toUpperCase()}</span>
												{:else}
													<span class="text-slate-400">{m['bv8.no_data']()}</span>
												{/each}
											</dd>
										</div>
									</dl>
								</div>
								{#if cycle.sessions.length === 0}
									<p class="px-5 pb-5 text-sm text-slate-500">{m['bv8.cycle_no_sessions']()}</p>
								{:else}
									<div class="max-h-[28rem] min-w-0 overflow-auto border-t border-slate-100">
										<table class="w-full min-w-max text-left text-xs">
											<caption class="sr-only">{m['bv8.cycle_sessions']({ number: attempt.number })}</caption>
											<thead class="sticky top-0 z-10 bg-slate-50 text-slate-500">
												<tr>
													<th scope="col" class="px-4 py-3 font-medium">{m['bv8.date']()}</th>
													<th scope="col" class="px-3 py-3 font-medium">{m['bv8.time']()}</th>
													<th scope="col" class="px-3 py-3 font-medium">{m['bv8.length']()}</th>
													<th scope="col" class="px-3 py-3 font-medium">{m['bv8.change']()}</th>
													<th scope="col" class="px-3 py-3 font-medium">{m['bv8.position']()}</th>
													<th scope="col" class="px-3 py-3 font-medium">{m['bv8.source']()}</th>
												</tr>
											</thead>
											<tbody>
												{#each cycle.sessions as session (session.id)}
													{@const tone = changeTone(session.change)}
													<tr class="border-t border-slate-100 text-slate-700">
														<td class="whitespace-nowrap px-4 py-3 font-medium">{dateFormatter.format(new Date(session.started_at))}</td>
														<td class="whitespace-nowrap px-3 py-3">{timeFormatter.format(new Date(session.started_at))}</td>
														<td class="whitespace-nowrap px-3 py-3">{formatDuration(session.active_seconds)}</td>
														<td class={`whitespace-nowrap px-3 py-3 font-medium ${tone === 'positive' ? 'text-emerald-700' : tone === 'negative' ? 'text-amber-700' : 'text-slate-500'}`}>{formatChange(session.change)}</td>
														<td class="whitespace-nowrap px-3 py-3">{position(session)}</td>
														<td class="px-3 py-3"><span title={session.device} class="rounded bg-slate-100 px-2 py-1 font-semibold text-slate-600">{session.source.toUpperCase()}</span></td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								{/if}
							</section>
						</li>
					{/each}
				</ol>
			{/if}
		{:else if loading && !error}
			<p class="card p-6 text-slate-600" role="status">{m['bv8.cycles_loading']()}</p>
		{/if}
	{/if}
</section>
