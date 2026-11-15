<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { api, ApiError } from '#lib/api/client.js';
	import { translate } from '#lib/paging/translate.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { browserTimeZone, statsErrorKey } from './api.js';
	import type { ReadingStats } from './reading-types.js';
	import { defaultReadingMonth } from './reading-habits.js';
	import YearScroller from './YearScroller.svelte';
	import ReadingHeatmap from './ReadingHeatmap.svelte';
	import ReadingHabits from './ReadingHabits.svelte';
	import ReadingCompletionRace from './ReadingCompletionRace.svelte';

	type Track = 'heatmap' | 'weekdays' | 'hours' | 'race';
	type HabitTrack = 'weekdays' | 'hours';
	type LoadState =
		| { status: 'loading' }
		| { status: 'ready'; data: ReadingStats }
		| { status: 'error'; error: unknown };
	const timeZone = browserTimeZone();
	const currentYear = new Date().getFullYear();
	let years = $state<Record<Track, number>>({ heatmap: currentYear, weekdays: currentYear, hours: currentYear, race: currentYear });
	let monthSelections = $state<Partial<Record<HabitTrack, { year: number; month: number }>>>({});
	let results = $state<Record<number, LoadState>>({});
	const controller = new AbortController();
	const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';
	const locale = $derived(getLocale());
	const months = $derived(Array.from({ length: 12 }, (_, index) =>
		new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, index, 1)))));

	onMount(() => void load(currentYear));
	onDestroy(() => controller.abort());

	async function load(year: number) {
		if (results[year]?.status === 'loading' || results[year]?.status === 'ready') return;
		results[year] = { status: 'loading' };
		try {
			const data = await api.request<ReadingStats>(
				`/stats/reading?${new URLSearchParams({ year: String(year).padStart(4, '0'), timezone: timeZone })}`,
				{ signal: controller.signal, cache: 'no-store' }
			);
			if (controller.signal.aborted) return;
			if (data.year !== year || data.timezone !== timeZone) throw new Error('Reading statistics returned a different year or timezone.');
			results[year] = { status: 'ready', data };
		} catch (error) {
			if (controller.signal.aborted) return;
			console.error('Could not load yearly reading stats', error);
			results[year] = { status: 'error', error };
		}
	}

	function selectYear(track: Track, year: number) {
		years[track] = year;
		void load(year);
	}

	function monthFor(track: HabitTrack, year: number): number {
		const selection = monthSelections[track];
		return selection?.year === year ? selection.month : defaultReadingMonth(year, timeZone);
	}

	function selectMonth(track: HabitTrack, year: number, month: number) {
		monthSelections[track] = { year, month };
	}
</script>

<svelte:head>
	<title>{m['organize.reading']()} · {m['common.app_name']()}</title>
</svelte:head>

{#snippet panel(track: Track, title: string)}
	{@const year = years[track]}
	{@const result = results[year]}
	<section class="card min-w-0" aria-label={title} aria-busy={!result || result.status === 'loading'}>
		<header class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
			<h2 class="text-base font-semibold text-slate-900">{title}</h2>
			<div class="flex items-center gap-2">
				<YearScroller {year} compact={track === 'weekdays' || track === 'hours'} onchange={(value) => selectYear(track, value)} />
				{#if track === 'weekdays' || track === 'hours'}
					{@const habitTrack = track}
					<label class="sr-only" for={`${habitTrack}-month`}>{m['stats.reading.month']()}</label>
					<select id={`${habitTrack}-month`} class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 {focusRing}"
						value={monthFor(habitTrack, year)} onchange={(event) => selectMonth(habitTrack, year, Number(event.currentTarget.value))}>
						<option value={0}>{m['stats.reading.all_months']()}</option>
						{#each months as name, index}
							<option value={index + 1}>{name}</option>
						{/each}
					</select>
				{/if}
			</div>
		</header>
		<div class="min-w-0 p-4 sm:p-5">
			{#if !result || result.status === 'loading'}
				<p class="text-sm text-slate-600" role="status">{m['stats.loading']()}</p>
			{:else if result.status === 'error'}
				{@const kind = requestErrorKind(result.error)}
				<div class="space-y-2 text-sm text-red-800" role="alert">
					<p>{translate(statsErrorKey(result.error))}</p>
					{#if result.error instanceof ApiError && typeof result.error.problem?.detail === 'string'}
						<p>{m['stats.error.detail']({ detail: result.error.problem.detail })}</p>
					{/if}
					{#if kind === 'unauthorized'}
						<a class="underline {focusRing}" href="/login">{m['stats.sign_in']()}</a>
					{:else}
						<button class="underline {focusRing}" onclick={() => load(year)}>{m['stats.retry']()}</button>
					{/if}
				</div>
			{:else if track === 'heatmap'}
				<ReadingHeatmap data={result.data} />
			{:else if track === 'weekdays' || track === 'hours'}
				<ReadingHabits data={result.data} mode={track} month={monthFor(track, year)} />
			{:else}
				<ReadingCompletionRace data={result.data} />
			{/if}
		</div>
	</section>
{/snippet}

<section class="space-y-6" aria-labelledby="reading-stats-heading">
	<h1 id="reading-stats-heading" class="sr-only">{m['organize.reading']()}</h1>
	{@render panel('heatmap', m['stats.reading.heatmap']())}
	<div class="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
		{@render panel('weekdays', m['stats.reading.weekdays']())}
		{@render panel('hours', m['stats.reading.time_range']())}
	</div>
	{@render panel('race', m['stats.reading.race']())}
</section>
