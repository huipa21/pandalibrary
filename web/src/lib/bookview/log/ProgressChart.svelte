<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatPercent } from '../format.js';
	import type { ReadingSummary } from '../log-api.js';
	import { CHART, chartSeries, formatCalendarDay, type ChartMode, type ChartPoint } from './log-model.js';

	let { summary }: { summary: ReadingSummary } = $props();
	let mode = $state<ChartMode>('curve');
	let hovered = $state<number | null>(null);
	let focused = $state<number | null>(null);
	let containerWidth = $state(0);
	const locale = $derived(getLocale());
	const width = $derived(containerWidth === 0
		? CHART.width
		: Math.max(containerWidth, CHART.left + CHART.right + 1));
	const series = $derived(chartSeries(summary.days, mode, width));
	const active = $derived(focused ?? hovered);
	const activePoint = $derived(active === null ? null : series.points[active] ?? null);
	const number = $derived(new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }));
	const description = $derived(m['bv8.chart_summary']({
		days: summary.active_days, progress: formatPercent(summary.progress, locale)
	}));

	function pointLabel(point: ChartPoint): string {
		const reached = point.day.max_percentage === null
			? m['bv8.unknown_position']()
			: `${m['bv8.chart_progress']()}: ${formatPercent(point.day.max_percentage, locale)}`;
		return m['bv8.chart_point']({
			date: formatCalendarDay(point.day.date, locale), minutes: number.format(point.minutes), reached
		});
	}

	function pointKey(event: KeyboardEvent, index: number) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			focused = index;
		}
	}
</script>

<section class="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6" aria-labelledby="bv8-chart-heading">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<h2 id="bv8-chart-heading" class="text-xs font-semibold uppercase tracking-wider text-slate-500">{m['bv8.chart']()}</h2>
			<p class="mt-1 text-sm text-slate-600">{m['bv8.chart_span']({ active: summary.active_days, span: summary.span_days })}</p>
		</div>
		<div class="flex rounded-lg border border-slate-200 p-1 text-sm" role="group" aria-label={m['bv8.chart_mode']()}>
			<button type="button" aria-pressed={mode === 'curve'} class={`rounded-md px-3 py-1 focus-visible:outline-2 focus-visible:outline-emerald-700 ${mode === 'curve' ? 'bg-emerald-50 font-semibold text-emerald-800' : 'text-slate-600'}`} onclick={() => (mode = 'curve')}>{m['bv8.curve']()}</button>
			<button type="button" aria-pressed={mode === 'trace'} class={`rounded-md px-3 py-1 focus-visible:outline-2 focus-visible:outline-emerald-700 ${mode === 'trace' ? 'bg-emerald-50 font-semibold text-emerald-800' : 'text-slate-600'}`} onclick={() => (mode = 'trace')}>{m['bv8.trace']()}</button>
		</div>
	</div>
	{#if summary.active_days > summary.days.length}
		<p class="mt-3 text-xs text-slate-500">{m['bv8.chart_limited']({ shown: summary.days.length, total: summary.active_days })}</p>
	{/if}
	<div class="mt-4 flex flex-wrap gap-4 text-xs text-slate-600" aria-hidden="true">
		<span class="inline-flex items-center gap-2"><span class="h-0.5 w-5 bg-emerald-600"></span>{m['bv8.chart_progress']()}</span>
		<span class="inline-flex items-center gap-2"><span class="h-3 w-3 rounded-sm bg-slate-300"></span>{m['bv8.chart_minutes']()}</span>
	</div>
	{#if series.points.length === 0}
		<p class="mt-5 rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">{m['bv8.chart_empty']()}</p>
	{:else}
		<figure class="mt-4 min-w-0">
			<div class="relative min-w-0" bind:clientWidth={containerWidth}>
				<svg class="h-60 w-full overflow-visible" viewBox={`0 0 ${width} ${CHART.height}`} preserveAspectRatio="none" role="img" aria-label={description}>
					<title>{description}</title>
					{#each series.percentTicks as tick (tick.value)}
						<line x1={CHART.left} x2={width - CHART.right} y1={tick.y} y2={tick.y} class="stroke-slate-100" vector-effect="non-scaling-stroke" />
						<text x={CHART.left - 7} y={tick.y + 4} text-anchor="end" class="fill-slate-500 text-[11px]">{tick.value}%</text>
					{/each}
					{#each series.minuteTicks as tick (tick.value)}
						<text x={width - CHART.right + 7} y={tick.y + 4} text-anchor="start" class="fill-slate-500 text-[11px]">{number.format(tick.value)}</text>
					{/each}
					{#each series.points as point (point.day.date)}
						<rect x={Math.max(CHART.left, Math.min(width - CHART.right - series.barWidth, point.x - series.barWidth / 2))}
							y={point.barY} width={series.barWidth} height={point.barHeight} class="fill-slate-200" />
					{/each}
					{#if series.path}
						<path data-testid="bv8-chart-line" d={series.path} fill="none" class="stroke-emerald-600" stroke-width="2.5" vector-effect="non-scaling-stroke" />
					{/if}
					{#each series.dateTicks as tick, index (tick.date)}
						<text x={tick.x} y={CHART.height - 14} text-anchor={index === 0 ? 'start' : index === series.dateTicks.length - 1 ? 'end' : 'middle'} class="fill-slate-500 text-[11px]">
							{formatCalendarDay(tick.date, locale, { year: undefined })}
						</text>
					{/each}
					{#each series.points as point, index (point.day.date)}
						<g role="button" tabindex="0" aria-label={pointLabel(point)}
							onmouseenter={() => (hovered = index)} onmouseleave={() => (hovered = null)}
							onfocus={() => (focused = index)} onblur={() => (focused = null)}
							onclick={() => (focused = index)} onkeydown={(event) => pointKey(event, index)}
							class="cursor-pointer focus:outline-none">
							<title>{pointLabel(point)}</title>
							<circle cx={point.x} cy={point.y ?? point.barY} r="9" fill="transparent" />
							{#if point.y !== null}
								<circle cx={point.x} cy={point.y} r="3" class="fill-emerald-600" vector-effect="non-scaling-stroke" />
							{/if}
						</g>
					{/each}
				</svg>
				{#if activePoint}
					{@const position = activePoint.x / width * 100}
					<p role="status" class="pointer-events-none absolute top-0 z-10 w-56 max-w-full rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-lg"
						style:left={`${position}%`} style:transform={`translateX(-${position}%)`}>
						{pointLabel(activePoint)}
					</p>
				{/if}
			</div>
			<details class="mt-2 text-sm text-slate-600">
				<summary class="cursor-pointer font-medium text-emerald-700 focus-visible:outline-2 focus-visible:outline-emerald-700">{m['bv8.chart_data']()}</summary>
				<table class="mt-3 w-full text-left text-xs">
					<thead><tr><th class="p-1">{m['bv8.day']()}</th><th class="p-1">{m['bv8.chart_minutes']()}</th><th class="p-1">{m['bv8.reached']()}</th></tr></thead>
					<tbody>
						{#each series.points as point (point.day.date)}
							<tr class="border-t border-slate-100">
								<td class="p-1">{formatCalendarDay(point.day.date, locale)}</td>
								<td class="p-1">{number.format(point.minutes)}</td>
								<td class="p-1">{point.day.max_percentage === null ? m['bv8.no_data']() : formatPercent(point.day.max_percentage, locale)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
			<figcaption class="sr-only">{description}</figcaption>
		</figure>
	{/if}
</section>
