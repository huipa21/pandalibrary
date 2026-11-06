<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { ApiError } from '#lib/api/client.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { translate } from '#lib/paging/translate.js';
	import BarChart from '#lib/stats/BarChart.svelte';
	import {
		browserTimeZone,
		DEFAULT_RANGE_DAYS,
		fetchStats,
		formatCalendar,
		formatDuration,
		MAX_RANGE_DAYS,
		RANGE_PRESETS,
		rangeEndingToday,
		statsErrorKey,
		totals,
		validateRange,
		type RangeIssue
	} from '#lib/stats/api.js';
	import type { Bar, DateRange, StatsResponse } from '#lib/stats/types.js';

	const timeZone = browserTimeZone();
	const initial = rangeEndingToday(DEFAULT_RANGE_DAYS);
	let from = $state(initial.from);
	let to = $state(initial.to);
	let issue = $state<RangeIssue | null>(null);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let data = $state<StatsResponse | null>(null);
	let error = $state<unknown>(null);
	let controller: AbortController | null = null;
	let pendingKey = '';

	const locale = $derived(getLocale());
	const summary = $derived(data ? totals(data.daily) : null);
	const errorKind = $derived(requestErrorKind(error));
	const serverDetail = $derived(
		error instanceof ApiError && errorKind === 'invalid' && typeof error.problem?.detail === 'string' ? error.problem.detail : ''
	);
	const dailyBars = $derived<Bar[]>(
		(data?.daily ?? []).map((day) => ({
			key: day.date,
			label: formatCalendar(day.date, locale),
			value: day.active_seconds,
			display: formatDuration(day.active_seconds)
		}))
	);
	const monthBars = $derived<Bar[]>(
		(data?.finished_per_month ?? []).map((month) => ({
			key: month.month,
			label: formatCalendar(month.month, locale, true),
			value: month.books_finished,
			display: String(month.books_finished)
		}))
	);
	const longestBook = $derived(Math.max(0, ...(data?.time_per_book ?? []).map((book) => book.active_seconds)));

	onMount(() => void load({ from, to }));
	onDestroy(() => controller?.abort());

	async function load(range: DateRange) {
		issue = validateRange(range);
		if (issue) return;
		const key = `${range.from}/${range.to}`;
		if (status === 'loading' && key === pendingKey && controller) return;

		controller?.abort();
		const current = new AbortController();
		controller = current;
		pendingKey = key;
		status = 'loading';
		error = null;
		try {
			const result = await fetchStats(range, timeZone, current.signal);
			if (current.signal.aborted) return;
			data = result;
			status = 'ready';
		} catch (cause) {
			if (current.signal.aborted) return;
			console.error('Could not load reading stats', cause);
			error = cause;
			status = 'error';
		} finally {
			if (controller === current) controller = null;
		}
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		void load({ from, to });
	}

	function preset(days: number) {
		({ from, to } = rangeEndingToday(days));
		void load({ from, to });
	}

	function issueMessage(value: RangeIssue): string {
		switch (value) {
			case 'invalid_from':
				return m['stats.validation.invalid_from']();
			case 'invalid_to':
				return m['stats.validation.invalid_to']();
			case 'reversed':
				return m['stats.validation.reversed']();
			case 'too_long':
				return m['stats.validation.too_long']({ max: MAX_RANGE_DAYS });
		}
	}

	const inputClass =
		'rounded-md border border-slate-300 bg-white px-3 py-2 text-base font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';
	const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';
</script>

<svelte:head>
	<title>{m['stats.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="stats-heading">
	<h1 id="stats-heading" class="sr-only">{m['stats.title']()}</h1>

	<form class="space-y-4 rounded-md border border-slate-200 bg-white p-4" onsubmit={submit} novalidate>
		<fieldset class="space-y-3">
			<legend class="font-medium">{m['stats.range.legend']()}</legend>
			<div class="flex flex-wrap items-end gap-3">
				<label class="grid gap-1 text-sm font-medium" for="stats-from">
					<span>{m['stats.range.from']()}</span>
					<input
						id="stats-from"
						type="date"
						class={inputClass}
						bind:value={from}
						max={to || undefined}
						aria-invalid={issue === 'invalid_from' || issue === 'reversed' || issue === 'too_long' ? 'true' : undefined}
						aria-describedby="stats-range-hint{issue ? ' stats-range-issue' : ''}"
						required
					/>
				</label>
				<label class="grid gap-1 text-sm font-medium" for="stats-to">
					<span>{m['stats.range.to']()}</span>
					<input
						id="stats-to"
						type="date"
						class={inputClass}
						bind:value={to}
						min={from || undefined}
						aria-invalid={issue === 'invalid_to' || issue === 'reversed' || issue === 'too_long' ? 'true' : undefined}
						aria-describedby="stats-range-hint{issue ? ' stats-range-issue' : ''}"
						required
					/>
				</label>
				<button type="submit" class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60 {focusRing}">
					{m['stats.range.submit']()}
				</button>
			</div>
			<p id="stats-range-hint" class="text-sm text-slate-600">
				{m['stats.range.hint']({ max: MAX_RANGE_DAYS })}
				{m['stats.range.timezone']({ timezone: timeZone })}
			</p>
		</fieldset>
		<div class="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label={m['stats.range.presets']()}>
			<span class="text-slate-600">{m['stats.range.presets']()}</span>
			{#each RANGE_PRESETS as days (days)}
				<button type="button" class="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-100 {focusRing}" onclick={() => preset(days)}>
					{m['stats.range.last_days']({ days })}
				</button>
			{/each}
		</div>
		{#if issue}
			<p id="stats-range-issue" class="text-sm text-red-700" role="alert">{issueMessage(issue)}</p>
		{/if}
	</form>

	{#if status === 'error'}
		<div class="space-y-2 rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
			<p>{translate(statsErrorKey(error))}</p>
			{#if serverDetail}<p class="text-sm">{m['stats.error.detail']({ detail: serverDetail })}</p>{/if}
			{#if errorKind === 'unauthorized'}
				<a class="font-medium underline underline-offset-4 {focusRing}" href="/login">{m['stats.sign_in']()}</a>
			{:else if errorKind !== 'invalid'}
				<button class="font-medium underline underline-offset-4 {focusRing}" onclick={() => load({ from, to })}>{m['stats.retry']()}</button>
			{/if}
		</div>
	{/if}

	{#if status === 'loading'}
		<p class="text-slate-600" role="status">{m['stats.loading']()}</p>
	{/if}

	{#if data && summary && status !== 'error'}
		<div class="space-y-10" aria-busy={status === 'loading'}>
			<p class="text-sm text-slate-600" role="status">
				{m['stats.showing']({ from: formatCalendar(data.from, locale), to: formatCalendar(data.to, locale), timezone: data.timezone })}
			</p>

			<dl class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
				<div class="rounded-md border border-slate-200 bg-white p-4">
					<dt class="text-sm text-slate-600">{m['stats.summary.total_time']()}</dt>
					<dd class="text-2xl font-semibold">{formatDuration(summary.activeSeconds)}</dd>
				</div>
				<div class="rounded-md border border-slate-200 bg-white p-4">
					<dt class="text-sm text-slate-600">{m['stats.summary.sessions']()}</dt>
					<dd class="text-2xl font-semibold">{summary.sessions}</dd>
				</div>
				<div class="rounded-md border border-slate-200 bg-white p-4">
					<dt class="text-sm text-slate-600">{m['stats.summary.active_days']()}</dt>
					<dd class="text-2xl font-semibold">{summary.activeDays}</dd>
				</div>
				<div class="rounded-md border border-slate-200 bg-white p-4">
					<dt class="text-sm text-slate-600">{m['stats.streaks.current']()}</dt>
					<dd class="text-2xl font-semibold" data-testid="current-streak">{data.streaks.current_days}</dd>
					<dd class="text-xs text-slate-500">{m['stats.streaks.current_hint']({ to: formatCalendar(data.to, locale) })}</dd>
				</div>
				<div class="rounded-md border border-slate-200 bg-white p-4">
					<dt class="text-sm text-slate-600">{m['stats.streaks.longest']()}</dt>
					<dd class="text-2xl font-semibold" data-testid="longest-streak">{data.streaks.longest_days}</dd>
					<dd class="text-xs text-slate-500">{m['stats.streaks.longest_hint']({ to: formatCalendar(data.to, locale) })}</dd>
				</div>
			</dl>

			<section class="space-y-3" aria-labelledby="stats-daily-heading">
				<h2 id="stats-daily-heading" class="text-xl font-semibold">{m['stats.daily.heading']()}</h2>
				<BarChart
					bars={dailyBars}
					label={m['stats.daily.chart_label']({ from: formatCalendar(data.from, locale), to: formatCalendar(data.to, locale) })}
					empty={m['stats.daily.empty']()}
				/>
				<!-- The scrollable table must be focusable so keyboard users can scroll every day. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div
					class="max-h-80 overflow-auto rounded-md border border-slate-200 bg-white {focusRing}"
					role="region"
					aria-labelledby="stats-daily-caption"
					tabindex="0"
				>
					<table class="w-full text-left text-sm">
						<caption id="stats-daily-caption" class="px-3 py-2 text-left text-slate-600">{m['stats.daily.table_caption']()}</caption>
						<thead class="sticky top-0 bg-slate-100">
							<tr>
								<th scope="col" class="px-3 py-2">{m['stats.table.date']()}</th>
								<th scope="col" class="px-3 py-2">{m['stats.table.time']()}</th>
								<th scope="col" class="px-3 py-2">{m['stats.table.sessions']()}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.daily as day (day.date)}
								<tr class="border-t border-slate-100">
									<th scope="row" class="px-3 py-1.5 font-normal"><time datetime={day.date}>{formatCalendar(day.date, locale)}</time></th>
									<td class="px-3 py-1.5">{formatDuration(day.active_seconds)}</td>
									<td class="px-3 py-1.5">{day.session_count}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<section class="space-y-3" aria-labelledby="stats-finished-heading">
				<h2 id="stats-finished-heading" class="text-xl font-semibold">{m['stats.finished.heading']()}</h2>
				<BarChart bars={monthBars} label={m['stats.finished.chart_label']()} empty={m['stats.finished.empty']()} />
				<div class="overflow-auto rounded-md border border-slate-200 bg-white">
					<table class="w-full text-left text-sm">
						<caption class="px-3 py-2 text-left text-slate-600">{m['stats.finished.table_caption']()}</caption>
						<thead class="bg-slate-100">
							<tr>
								<th scope="col" class="px-3 py-2">{m['stats.table.month']()}</th>
								<th scope="col" class="px-3 py-2">{m['stats.table.finished']()}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.finished_per_month as month (month.month)}
								<tr class="border-t border-slate-100">
									<th scope="row" class="px-3 py-1.5 font-normal"><time datetime={month.month}>{formatCalendar(month.month, locale, true)}</time></th>
									<td class="px-3 py-1.5">{month.books_finished}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<section class="space-y-3" aria-labelledby="stats-books-heading">
				<h2 id="stats-books-heading" class="text-xl font-semibold">{m['stats.books.heading']()}</h2>
				{#if data.time_per_book.length === 0}
					<p class="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">{m['stats.books.empty']()}</p>
				{:else}
					<div class="overflow-auto rounded-md border border-slate-200 bg-white">
						<table class="w-full text-left text-sm">
							<caption class="px-3 py-2 text-left text-slate-600">{m['stats.books.table_caption']()}</caption>
							<thead class="bg-slate-100">
								<tr>
									<th scope="col" class="px-3 py-2">{m['stats.table.book']()}</th>
									<th scope="col" class="px-3 py-2">{m['stats.table.time']()}</th>
									<th scope="col" class="px-3 py-2">{m['stats.table.sessions']()}</th>
								</tr>
							</thead>
							<tbody>
								{#each data.time_per_book as book (book.book_id)}
									<tr class="border-t border-slate-100 align-top">
										<th scope="row" class="px-3 py-2 font-normal">
											<a class="font-medium underline-offset-4 hover:underline {focusRing}" href={`/books/${book.book_id}`}>{book.title}</a>
											<span class="block text-xs text-slate-500">
												{book.authors.length ? book.authors.join(', ') : m['stats.books.unknown_author']()}
											</span>
										</th>
										<td class="min-w-40 px-3 py-2">
											<span>{formatDuration(book.active_seconds)}</span>
											<span class="mt-1 block h-2 rounded-full bg-slate-100" aria-hidden="true">
												<span
													class="block h-2 rounded-full bg-slate-700"
													style:width={`${longestBook > 0 ? Math.max(2, (book.active_seconds / longestBook) * 100) : 0}%`}
												></span>
											</span>
										</td>
										<td class="px-3 py-2">{book.session_count}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		</div>
	{/if}
</section>
