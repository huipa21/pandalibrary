<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { ReadingStats } from './reading-types.js';
	import { aggregateReadingHabits, defaultReadingMonth } from './reading-habits.js';

	interface Props {
		data: ReadingStats;
	}

	let { data }: Props = $props();
	const id = $props.id();
	const now = new Date();
	let selection = $state<{ year: number; month: number } | null>(null);
	const month = $derived(selection?.year === data.year ? selection.month : defaultReadingMonth(data.year, data.timezone, now));
	const locale = $derived(getLocale());
	const totals = $derived(aggregateReadingHabits(data, month));
	const weekdayPeak = $derived(Math.max(1 / 3600, ...totals.weekdays));
	const hourPeak = $derived(Math.max(1 / 3600, ...totals.hours));
	const weekdayNames = $derived(Array.from({ length: 7 }, (_, index) =>
		new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index)))));
	const weekdayLabels = $derived(Array.from({ length: 7 }, (_, index) =>
		new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index)))));
	const months = $derived(Array.from({ length: 12 }, (_, index) =>
		new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, index, 1)))));
	const numberFormatter = $derived(new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }));
	const empty = $derived(!totals.weekdays.some((hours) => hours > 0) && !totals.hours.some((hours) => hours > 0));

	function hoursLabel(hours: number): string {
		return m['stats.reading.hours']({ hours: numberFormatter.format(hours) });
	}

	function hourRange(hour: number): string {
		return m['stats.reading.hour_range']({
			from: `${String(hour).padStart(2, '0')}:00`,
			to: `${String(hour + 1).padStart(2, '0')}:00`
		});
	}

	function point(radius: number, angle: number): string {
		return `${160 + radius * Math.sin(angle)} ${160 - radius * Math.cos(angle)}`;
	}

	function radialBar(hour: number, radius: number): string {
		const start = (hour + 0.08) * Math.PI / 12;
		const end = (hour + 0.92) * Math.PI / 12;
		return `M ${point(70, start)} L ${point(radius, start)} A ${radius} ${radius} 0 0 1 ${point(radius, end)} L ${point(70, end)} A 70 70 0 0 0 ${point(70, start)} Z`;
	}
</script>

<div class="habits">
	<div class="filter">
		<label for={`${id}-month`}>{m['stats.reading.month']()}</label>
		<select id={`${id}-month`} value={month} onchange={(event) => selection = { year: data.year, month: Number(event.currentTarget.value) }}>
			<option value={0}>{m['stats.reading.all_months']()}</option>
			{#each months as name, index}
				<option value={index + 1}>{name}</option>
			{/each}
		</select>
	</div>

	{#if empty}
		<p class="empty" role="status">{m['stats.reading.habits_empty']()}</p>
	{:else}
		<div class="charts">
			<figure>
				<figcaption>{m['stats.reading.weekdays']()}</figcaption>
				<svg class="weekday-chart" viewBox="0 0 350 240" role="img" aria-label={m['stats.reading.weekdays']()}>
					<line x1="0" y1="204" x2="350" y2="204" class="axis" />
					{#each totals.weekdays as hours, index}
						<g>
							<rect x={index * 50 + 9} y={204 - hours / weekdayPeak * 164} width="32" height={hours / weekdayPeak * 164} rx="3" class="bar">
								<title>{weekdayNames[index]}: {hoursLabel(hours)}</title>
							</rect>
							<text x={index * 50 + 25} y={194 - hours / weekdayPeak * 164} class="value">{numberFormatter.format(hours)}</text>
							<text x={index * 50 + 25} y="226" class="weekday-label">{weekdayLabels[index]}</text>
						</g>
					{/each}
				</svg>
				<details>
					<summary>{m['stats.reading.weekday_table']()}</summary>
					<table>
						<caption>{m['stats.reading.weekdays']()}</caption>
						<thead><tr><th scope="col">{m['stats.reading.weekday']()}</th><th scope="col">{m['stats.reading.hour']()}</th></tr></thead>
						<tbody>
							{#each totals.weekdays as hours, index}
								<tr><th scope="row">{weekdayNames[index]}</th><td>{hoursLabel(hours)}</td></tr>
							{/each}
						</tbody>
					</table>
				</details>
			</figure>
			<figure>
				<figcaption>{m['stats.reading.time_range']()}</figcaption>
				<svg class="hour-chart" viewBox="0 0 320 320" role="img" aria-label={m['stats.reading.time_range']()}>
					{#each totals.hours as hours, hour}
						<g>
							<path d={radialBar(hour, 126)} class="track" />
							{#if hours > 0}
								<path d={radialBar(hour, 70 + hours / hourPeak * 56)} class="bar">
									<title>{hourRange(hour)}: {hoursLabel(hours)}</title>
								</path>
							{:else}
								<title>{hourRange(hour)}: {hoursLabel(hours)}</title>
							{/if}
							<text x={160 + 58 * Math.sin((hour + 0.5) * Math.PI / 12)} y={160 - 58 * Math.cos((hour + 0.5) * Math.PI / 12)} class="hour-label">{hour}</text>
						</g>
					{/each}
					<text x="160" y="14" class="clock-label">0 / 24</text>
					<text x="306" y="160" class="clock-label">6</text>
					<text x="160" y="306" class="clock-label">12</text>
					<text x="14" y="160" class="clock-label">18</text>
				</svg>
				<details>
					<summary>{m['stats.reading.hour_table']()}</summary>
					<table>
						<caption>{m['stats.reading.time_range']()}</caption>
						<thead><tr><th scope="col">{m['stats.reading.time_range']()}</th><th scope="col">{m['stats.reading.hour']()}</th></tr></thead>
						<tbody>
							{#each totals.hours as hours, hour}
								<tr><th scope="row">{hourRange(hour)}</th><td>{hoursLabel(hours)}</td></tr>
							{/each}
						</tbody>
					</table>
				</details>
			</figure>
		</div>
	{/if}
</div>

<style>
	.habits { display: grid; gap: 1rem; min-width: 0; }
	.filter { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.5rem; font-size: 0.8125rem; }
	select { max-width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; padding: 0.375rem 0.5rem; background: white; color: #334155; font: inherit; }
	select:focus-visible, summary:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
	.charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; }
	figure { margin: 0; min-width: 0; }
	figcaption { color: #334155; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; }
	svg { display: block; width: 100%; }
	.weekday-chart { aspect-ratio: 350 / 240; }
	.hour-chart { max-width: 22rem; margin: 0 auto; }
	.axis { stroke: #cbd5e1; }
	.bar { fill: #0f766e; }
	.track { fill: #f1f5f9; }
	text { text-anchor: middle; fill: #64748b; font-family: inherit; }
	.weekday-label { font-size: 11px; }
	.value { font-size: 11px; fill: #334155; }
	.hour-label { font-size: 10px; dominant-baseline: middle; }
	.clock-label { font-size: 12px; font-weight: 600; dominant-baseline: middle; }
	details { margin-top: 0.75rem; border-top: 1px solid #e2e8f0; padding-top: 0.75rem; font-size: 0.8125rem; }
	summary { cursor: pointer; color: #64748b; overflow-wrap: anywhere; }
	table { width: 100%; margin-top: 0.75rem; border-collapse: collapse; text-align: left; }
	caption { text-align: left; font-weight: 600; margin-bottom: 0.5rem; }
	th, td { border-bottom: 1px solid #f1f5f9; padding: 0.375rem; overflow-wrap: anywhere; }
	th { font-weight: 400; }
	td { text-align: right; }
	.empty { margin: 0; border: 1px dashed #cbd5e1; border-radius: 6px; padding: 1.5rem; color: #64748b; text-align: center; }
	@media (max-width: 600px) { .charts { grid-template-columns: minmax(0, 1fr); } }
</style>
