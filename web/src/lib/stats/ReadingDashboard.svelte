<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { api, ApiError } from '#lib/api/client.js';
	import { translate } from '#lib/paging/translate.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { browserTimeZone, statsErrorKey } from './api.js';
	import type { ReadingStats } from './reading-types.js';
	import YearScroller from './YearScroller.svelte';
	import ReadingHeatmap from './ReadingHeatmap.svelte';
	import ReadingHabits from './ReadingHabits.svelte';
	import ReadingCompletionRace from './ReadingCompletionRace.svelte';

	type Track = 'heatmap' | 'weekdays' | 'hours' | 'race';
	type LoadState =
		| { status: 'loading' }
		| { status: 'ready'; data: ReadingStats }
		| { status: 'error'; error: unknown };
	const timeZone = browserTimeZone();
	const currentYear = new Date().getFullYear();
	let years = $state<Record<Track, number>>({ heatmap: currentYear, weekdays: currentYear, hours: currentYear, race: currentYear });
	let results = $state<Record<number, LoadState>>({});
	const controller = new AbortController();
	const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';

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
			<YearScroller {year} onchange={(value) => selectYear(track, value)} />
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
				<ReadingHabits data={result.data} mode={track} />
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
