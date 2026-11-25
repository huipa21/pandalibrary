<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { ReadingStats } from './reading-types.js';
	import { aggregateReadingHabits } from './reading-habits.js';

	interface Props {
		data: ReadingStats;
		mode: 'weekdays' | 'hours';
		month: number;
	}

	let { data, mode, month }: Props = $props();
	const totals = $derived(aggregateReadingHabits(data, month));
	const weekdayPeak = $derived(Math.max(1 / 3600, ...totals.weekdays));
	const hourPeak = $derived(Math.max(1 / 3600, ...totals.hours));
	const locale = $derived(getLocale());
	const weekdayNames = $derived(Array.from({ length: 7 }, (_, index) =>
		new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index)))));
	const weekdayLabels = $derived(Array.from({ length: 7 }, (_, index) =>
		new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index)))));
	const numberFormatter = $derived(new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }));
	const empty = $derived(!totals[mode].some((hours) => hours > 0));

	function hoursLabel(hours: number): string {
		return m['stats.reading.hours']({ hours: numberFormatter.format(hours) });
	}

	function hourLabel(hour: number): string {
		return String(hour === 0 ? 24 : hour);
	}

	function hourRange(hour: number): string {
		return m['stats.reading.hour_range']({
			from: `${hourLabel(hour)}:00`,
			to: `${hourLabel(hour + 1)}:00`
		});
	}

	function point(radius: number, angle: number): string {
		return `${160 + radius * Math.sin(angle)} ${160 - radius * Math.cos(angle)}`;
	}

	function radialBar(hour: number, radius: number): string {
		const start = (hour + 0.08) * Math.PI / 12;
		const end = (hour + 0.92) * Math.PI / 12;
		return `M ${point(16, start)} L ${point(radius, start)} A ${radius} ${radius} 0 0 1 ${point(radius, end)} L ${point(16, end)} A 16 16 0 0 0 ${point(16, start)} Z`;
	}
</script>

<div class="habits">
	{#if empty}
		<p class="empty" role="status">{m['stats.reading.habits_empty']()}</p>
	{:else}
		{#if mode === 'weekdays'}
			<figure>
				<svg class="weekday-chart" viewBox="0 0 350 350" role="img" aria-label={m['stats.reading.weekdays']()}>
					<line x1="0" y1="294" x2="350" y2="294" class="axis" />
					{#each totals.weekdays as hours, index}
						<g>
							<rect x={index * 50 + 9} y={294 - hours / weekdayPeak * 240} width="32" height={hours / weekdayPeak * 240} rx="3" class="bar">
								<title>{weekdayNames[index]}: {hoursLabel(hours)}</title>
							</rect>
							<text x={index * 50 + 25} y={284 - hours / weekdayPeak * 240} class="value">{numberFormatter.format(hours)}</text>
							<text x={index * 50 + 25} y="318" class="weekday-label">{weekdayLabels[index]}</text>
						</g>
					{/each}
				</svg>
			</figure>
		{:else}
			<figure>
				<svg class="hour-chart" viewBox="0 0 320 320" role="img" aria-label={m['stats.reading.time_range']()}>
					{#each [16, 41, 66, 91, 116] as radius}
						<circle cx="160" cy="160" r={radius} class="hour-guide" aria-hidden="true" />
					{/each}
					{#each totals.hours as hours, hour}
						<g>
							{#if hours > 0}
								<path d={radialBar(hour, 16 + hours / hourPeak * 100)} class="bar">
									<title>{hourRange(hour)}: {hoursLabel(hours)}</title>
								</path>
							{:else}
								<title>{hourRange(hour)}: {hoursLabel(hours)}</title>
							{/if}
							<text x={160 + 141 * Math.sin(hour * Math.PI / 12)} y={160 - 141 * Math.cos(hour * Math.PI / 12)} class="hour-label">{hourLabel(hour)}</text>
						</g>
					{/each}
				</svg>
			</figure>
		{/if}
	{/if}
</div>

<style>
	.habits { display: grid; gap: 1rem; min-width: 0; }
	figure { margin: 0; min-width: 0; }
	svg { display: block; width: 100%; max-width: 22rem; margin: 0 auto; }
	.axis { stroke: #cbd5e1; }
	.bar { fill: #0f766e; }
	.hour-guide { fill: none; stroke: #cbd5e1; stroke-width: 1; }
	text { text-anchor: middle; fill: #64748b; font-family: inherit; }
	.weekday-label { font-size: 11px; }
	.value { font-size: 11px; fill: #334155; }
	.hour-label { font-size: 10px; dominant-baseline: middle; font-variant-numeric: tabular-nums; }
	:global(:root[data-theme='dark']) .hour-guide { stroke: #475569; }
	:global(:root[data-theme='dark']) .hour-chart .bar { fill: #34d399; }
	:global(:root[data-theme='dark']) .hour-label { fill: #cbd5e1; }
	.empty { margin: 0; border: 1px dashed #cbd5e1; border-radius: 6px; padding: 1.5rem; color: #64748b; text-align: center; }
</style>
