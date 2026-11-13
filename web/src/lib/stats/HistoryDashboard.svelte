<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { api } from '#lib/api/client.js';
	import BookCover from '#lib/bookview/BookCover.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { translate } from '#lib/paging/translate.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { browserTimeZone, formatCalendar, statsErrorKey } from './api.js';
	import {
		createHistoryCache, formatHistoryDuration,
		type HistoryRow, type HistorySummary
	} from './history.js';

	const timeZone = browserTimeZone();
	const initialYear = new Date().getFullYear();
	let year = $state(initialYear);
	let requestedYear = $state(initialYear);
	let search = $state('');
	const years = Array.from({ length: initialYear }, (_, index) => initialYear - index);
	let rows = $state<HistoryRow[]>([]);
	let summary = $state<HistorySummary | null>(null);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let error = $state<unknown>(null);
	let cache: ReturnType<typeof createHistoryCache> | null = null;
	let controller: AbortController | null = null;
	let generation = 0;
	let destroyed = false;
	const cursors = new Set<string>();
	const locale = $derived(getLocale());
	const query = $derived(search.trim().toLocaleLowerCase(locale));
	const months = $derived.by(() => {
		const groups: { month: string; rows: HistoryRow[] }[] = [];
		for (const row of rows) {
			if (query && ![row.title, ...row.authors].some((value) => value.toLocaleLowerCase(locale).includes(query))) continue;
			const month = row.date.slice(0, 7);
			let group = groups[groups.length - 1];
			if (!group || group.month !== month) {
				group = { month, rows: [] };
				groups.push(group);
			}
			group.rows.push(row);
		}
		return groups;
	});
	const peakMonth = $derived(Math.max(1, ...(summary?.months.map((month) => month.active_seconds) ?? [])));

	$effect(() => {
		if (query && nextCursor !== null && !loading && !error) void loadMore();
	});

	onMount(() => void initialize());
	onDestroy(() => {
		destroyed = true;
		generation++;
		controller?.abort();
	});

	async function initialize() {
		loading = true;
		error = null;
		const current = new AbortController();
		controller = current;
		try {
			const { user } = await api.request<{ user: { id: number } }>('/auth/me', { signal: current.signal, cache: 'no-store' });
			if (destroyed) return;
			cache = createHistoryCache(user.id);
			await reset();
		} catch (cause) {
			if (current.signal.aborted) return;
			console.error('Could not initialize reading history', cause);
			error = cause;
			loading = false;
		}
	}

	async function reset() {
		if (!cache) return;
		controller?.abort();
		generation++;
		requestedYear = year;
		rows = [];
		summary = null;
		nextCursor = null;
		error = null;
		cursors.clear();
		loading = false;
		await loadMore();
	}

	async function loadMore() {
		if (!cache || loading || (summary && nextCursor === null)) return;
		const version = generation;
		const current = new AbortController();
		controller = current;
		loading = true;
		error = null;
		try {
			const page = await cache.load(requestedYear, timeZone, nextCursor, current.signal);
			if (current.signal.aborted || version !== generation) return;
			if (page.next_cursor !== null && cursors.has(page.next_cursor)) {
				throw new Error('The history API returned a repeated pagination cursor.');
			}
			if (page.next_cursor !== null) cursors.add(page.next_cursor);
			rows = [...rows, ...page.items];
			summary = page.summary;
			nextCursor = page.next_cursor;
		} catch (cause) {
			if (current.signal.aborted || version !== generation) return;
			console.error('Could not load reading history', cause);
			error = cause;
		} finally {
			if (version === generation) loading = false;
			if (controller === current) controller = null;
		}
	}

	function nearEnd(node: HTMLElement) {
		const observer = new IntersectionObserver(([entry]) => {
			if (entry.isIntersecting && !loading && !error && nextCursor !== null) void loadMore();
		}, { rootMargin: '400px' });
		observer.observe(node);
		return { destroy: () => observer.disconnect() };
	}

	function changeYear() {
		if (Number.isInteger(year) && year >= 1 && year <= 9998) void reset();
	}

	function retry() {
		if (!cache) void initialize();
		else void loadMore();
	}

	function number(value: number): string {
		return new Intl.NumberFormat(locale).format(value);
	}

	function monthLabel(month: string): string {
		return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
	}
</script>

<svelte:head>
	<title>{m['organize.history']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="history">
	<div class="history-layout">
		<section class="history-container card" aria-labelledby="history-heading">
			<header class="history-toolbar">
				<h1 id="history-heading">{m['organize.history']()}</h1>
				<label for="history-search" class="sr-only">{m['history.search']()}</label>
				<input id="history-search" type="search" placeholder={m['history.search']()} bind:value={search} />
				<label for="history-year" class="sr-only">{m['history.year']()}</label>
				<select id="history-year" bind:value={year} onchange={changeYear}>
					{#each years as option (option)}
						<option value={option}>{option}</option>
					{/each}
				</select>
			</header>
		<div class="waterfall" aria-busy={loading}>
			{#each months as group (group.month)}
				{@const monthSummary = summary?.months.find((month) => month.month === group.month)}
				<section aria-labelledby={`month-${group.month}`} class="history-month">
					<header class="month-heading">
						<h2 id={`month-${group.month}`}>{formatCalendar(group.month, locale, true)}</h2>
						{#if monthSummary}
							<p>{m['history.month_summary']({ books: number(monthSummary.books), sessions: number(monthSummary.session_count), duration: formatHistoryDuration(monthSummary.active_seconds) })}</p>
						{/if}
					</header>
					<ol class="history-rows">
						{#each group.rows as row, index (`${row.date}-${row.book_id}-${row.cycle}`)}
							{@const lastOfDay = group.rows[index + 1]?.date !== row.date && (index < group.rows.length - 1 || group !== months[months.length - 1] || nextCursor === null)}
							<li class="history-row" data-testid="history-row">
								<time datetime={row.date}>{formatCalendar(row.date, locale)}</time>
								<a class="cover-link" href={`/books/${row.book_id}`} tabindex="-1" aria-hidden="true">
									<BookCover id={row.book_id} title={row.title} coverUrl={row.cover_url} size="xs" />
								</a>
								<div class="book-info">
									<a class="book-title" href={`/books/${row.book_id}`}>{row.title}</a>
									<p class="muted authors">{row.authors.join(', ') || m['history.unknown_author']()}</p>
									<span class="cycle">{m['history.cycle']({ cycle: row.cycle })}</span>
								</div>
								<div class="row-total">
									{#if lastOfDay && !query}
										<span class="muted">{m['history.day_total']()}</span>
										<strong>{formatHistoryDuration(row.day_active_seconds)}</strong>
										<span class="muted">{m['history.sessions']({ count: number(row.day_session_count) })}</span>
									{:else}
										<span>{formatHistoryDuration(row.active_seconds)}</span>
										<span class="muted">{m['history.sessions']({ count: number(row.session_count) })}</span>
									{/if}
								</div>
							</li>
						{/each}
					</ol>
				</section>
			{/each}

			{#if error}
				<div role="alert" class="history-error">
					<p>{translate(statsErrorKey(error))}</p>
					{#if requestErrorKind(error) === 'unauthorized'}
						<a href="/login">{m['stats.sign_in']()}</a>
					{:else}
						<button type="button" onclick={retry}>{m['stats.retry']()}</button>
					{/if}
				</div>
			{:else if loading}
				<p role="status" class="history-status">{m['stats.loading']()}</p>
			{:else if summary && rows.length === 0}
				<p role="status" class="history-status">{m['history.empty']({ year: requestedYear })}</p>
			{:else if summary && months.length === 0}
				<p role="status" class="history-status">{m['history.search_empty']()}</p>
			{/if}

			{#if nextCursor !== null && !error}
				{#key rows.length}
					<div use:nearEnd class="load-more">
						<button type="button" disabled={loading} onclick={loadMore}>{m['history.load_more']()}</button>
					</div>
				{/key}
			{:else if rows.length > 0 && !loading && !error}
				<p class="history-status muted">{m['history.end']({ year: requestedYear })}</p>
			{/if}
		</div>
		</section>

		{#if summary}
			<aside class="year-summary card" aria-labelledby="year-summary-heading">
				<h2 id="year-summary-heading">{m['history.year_summary']({ year: requestedYear })}</h2>
				<section>
					<h3>{m['history.totals']()}</h3>
					<dl class="total-grid">
						<div><dd>{number(summary.books)}</dd><dt>{m['history.books']()}</dt></div>
						<div><dd>{number(summary.session_count)}</dd><dt>{m['stats.summary.sessions']()}</dt></div>
						<div><dd>{formatHistoryDuration(summary.active_seconds)}</dd><dt>{m['stats.summary.total_time']()}</dt></div>
						<div><dd>{number(summary.active_days)}</dd><dt>{m['stats.summary.active_days']()}</dt></div>
					</dl>
				</section>
				<section>
					<h3>{m['history.by_month']()}</h3>
					<div class="month-chart" role="img" aria-label={m['history.month_chart']()}>
						{#each summary.months as month (month.month)}
							<div class="chart-column">
								<div class="chart-track">
									<div class="chart-bar" style:height={`${month.active_seconds > 0 ? Math.max(3, month.active_seconds / peakMonth * 100) : 0}%`}></div>
								</div>
								<span>{monthLabel(month.month)}</span>
							</div>
						{/each}
					</div>
					<table class="month-table">
						<caption class="sr-only">{m['history.by_month']()}</caption>
						<thead><tr><th scope="col">{m['history.month']()}</th><th scope="col">{m['history.books']()}</th><th scope="col">{m['stats.summary.total_time']()}</th></tr></thead>
						<tbody>
							{#each summary.months as month (month.month)}
								<tr><th scope="row">{monthLabel(month.month)}</th><td>{number(month.books)}</td><td>{formatHistoryDuration(month.active_seconds)}</td></tr>
							{/each}
						</tbody>
					</table>
				</section>
				<section>
					<h3>{m['history.records']()}</h3>
					<dl class="records">
						<div>
							<dt>{m['history.busiest_day']()}</dt>
							<dd>{#if summary.records.busiest_day}{formatCalendar(summary.records.busiest_day.date, locale)}<strong>{formatHistoryDuration(summary.records.busiest_day.active_seconds)}</strong>{:else}{m['history.no_record']()}{/if}</dd>
						</div>
						<div>
							<dt>{m['history.longest_session']()}</dt>
							<dd>{formatHistoryDuration(summary.records.longest_session_seconds)}</dd>
						</div>
						<div>
							<dt>{m['history.most_read_book']()}</dt>
							<dd>{#if summary.records.most_read_book}<a href={`/books/${summary.records.most_read_book.book_id}`}>{summary.records.most_read_book.title}</a><strong>{m['history.sessions']({ count: number(summary.records.most_read_book.session_count) })}</strong>{:else}{m['history.no_record']()}{/if}</dd>
						</div>
					</dl>
				</section>
			</aside>
		{/if}
	</div>
</section>

<style>
	.history { color: var(--shell-text); }
	.history-toolbar, .month-heading { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
	.history-toolbar { border-bottom: 1px solid var(--shell-border); padding: .75rem 1rem; }
	h1 { font-size: .85rem; font-weight: 700; }
	.muted { color: var(--shell-muted); }
	button, input, select { border: 1px solid var(--shell-border); border-radius: .375rem; background: var(--shell-surface); color: var(--shell-text); padding: .4rem .65rem; font-size: .8rem; }
	button { cursor: pointer; }
	button:hover:not(:disabled) { background: var(--shell-hover); }
	button:disabled { opacity: .5; cursor: default; }
	button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid var(--shell-active); outline-offset: 3px; }
	input { flex: 1; min-width: 8rem; width: 100%; }
	select { width: 6rem; margin-left: auto; }
	.history-layout { display: grid; grid-template-columns: minmax(0, 1fr) 20rem; gap: 1.25rem; align-items: start; }
	.history-container { min-width: 0; overflow: hidden; }
	.waterfall { min-width: 0; padding: 0 1rem; }
	.history-month { margin-bottom: 1.5rem; }
	.month-heading { justify-content: space-between; border-bottom: 1px solid var(--shell-border); padding: .5rem 0; gap: .25rem 1rem; }
	.month-heading h2 { font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
	.month-heading p { color: var(--shell-muted); font-size: .7rem; }
	.history-row { display: grid; grid-template-columns: 5.3rem 2.5rem minmax(0, 1fr) 9rem; gap: .8rem; align-items: center; padding: .85rem .65rem; border-bottom: 1px solid var(--shell-border); border-radius: .6rem .6rem 0 0; }
	.history-row:hover { background: var(--shell-hover); }
	time { color: var(--shell-muted); font-size: .7rem; align-self: start; padding-top: .15rem; }
	.cover-link { width: 2.5rem; }
	.book-info { min-width: 0; }
	.book-title { font-size: .85rem; font-weight: 600; overflow-wrap: anywhere; }
	a:hover { text-decoration: underline; }
	.authors { font-size: .75rem; margin: .15rem 0 .35rem; overflow-wrap: anywhere; }
	.cycle { display: inline-block; font-size: .65rem; color: var(--shell-text); border: 1px solid color-mix(in srgb, var(--shell-active) 35%, transparent); background: color-mix(in srgb, var(--shell-active) 7%, transparent); padding: 0 .4rem; border-radius: 999px; }
	.row-total { display: grid; gap: .15rem; font-size: .75rem; padding-left: 1rem; border-left: 1px solid var(--shell-border); }
	.row-total .muted { font-size: .65rem; }
	.history-status, .load-more { padding: 1.5rem; text-align: center; font-size: .85rem; }
	.history-error { border: 1px solid #e57373; border-radius: .5rem; padding: 1rem; margin-top: 1rem; }
	.history-error button, .history-error a { margin-top: .5rem; }
	.year-summary { overflow: hidden; }
	.year-summary > h2 { font-weight: 700; font-size: .85rem; padding: 1rem; }
	.year-summary section { border-top: 1px solid var(--shell-border); padding: 1rem; }
	h3 { color: var(--shell-muted); font-size: .75rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; margin-bottom: .75rem; }
	.total-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; border: 1px solid var(--shell-border); background: var(--shell-border); border-radius: .4rem; overflow: hidden; }
	.total-grid div { background: var(--shell-surface); padding: .7rem; }
	.total-grid dt { font-size: .75rem; color: var(--shell-muted); }
	.total-grid dd { font-size: 1rem; font-weight: 650; }
	.month-chart { display: flex; gap: .1rem; margin-bottom: 1rem; }
	.chart-column { flex: 1; min-width: 0; text-align: center; }
	.chart-track { display: flex; align-items: end; height: 5rem; border-bottom: 1px solid var(--shell-border); }
	.chart-bar { width: 100%; background: var(--shell-active); border-radius: 2px 2px 0 0; }
	.chart-column span { font-size: .65rem; color: var(--shell-muted); }
	.month-table { width: 100%; font-size: .75rem; }
	.month-table th { font-weight: 500; text-align: left; }
	.month-table td, .month-table th { padding: .15rem 0; }
	.month-table td { text-align: right; font-variant-numeric: tabular-nums; }
	.month-table thead th:not(:first-child) { text-align: right; }
	.month-table thead { color: var(--shell-muted); }
	.records { font-size: .85rem; display: grid; gap: 1rem; }
	.records dt { color: var(--shell-muted); font-size: .75rem; margin-bottom: .25rem; }
	.records dd { overflow-wrap: anywhere; }
	.records strong { display: block; font-size: .75rem; font-weight: 500; margin-top: .15rem; }
	@media (max-width: 75rem) {
		.history-layout { grid-template-columns: minmax(0, 1fr) 19rem; }
		.history-row { grid-template-columns: 3.5rem 2.25rem minmax(0, 1fr) 7rem; gap: .5rem; }
		.cover-link { width: 2.25rem; }
		.row-total { padding-left: .5rem; }
	}
	@media (max-width: 60rem) {
		.history-layout { grid-template-columns: minmax(0, 1fr); }
		.year-summary { max-width: 36rem; width: 100%; }
	}
	@media (max-width: 30rem) {
		.history-toolbar { gap: .5rem; padding: .75rem; }
		.history-toolbar h1 { width: 100%; }
		.waterfall { padding: 0 .75rem; }
		.history-row { grid-template-columns: 2.5rem minmax(0, 1fr) 5.7rem; padding: .75rem .25rem; }
		time { grid-column: 1 / -1; padding: 0; }
		.book-title { font-size: .8rem; }
	}
</style>
