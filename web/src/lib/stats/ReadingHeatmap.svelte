<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { addDays, dayNumber, durationParts, formatCalendar, totals } from './api.js';
	import { yearCalendar } from './heatmap-geometry.js';
	import type { ReadingStats } from './reading-types.js';

	let { data }: { data: ReadingStats } = $props();

	const locale = $derived(getLocale());
	const calendar = $derived(yearCalendar(data.year));
	const byDate = $derived(new Map(data.daily.map((day) => [day.date, day])));
	const daily = $derived(calendar.days.map((cell) => ({
		...cell,
		active_seconds: byDate.get(cell.date)?.active_seconds ?? 0,
		session_count: byDate.get(cell.date)?.session_count ?? 0
	})));
	const summary = $derived(totals(daily));
	const peak = $derived(Math.max(0, ...daily.map((day) => day.active_seconds)));
	const numbers = $derived(new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }));
	const counts = $derived(new Intl.NumberFormat(locale));
	const monthFormat = $derived(new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }));
	const weekdayFormat = $derived(new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }));
	const months = $derived(daily.filter((day) => day.date.endsWith('-01')));
	const weekdays = $derived(Array.from({ length: 7 }, (_, index) =>
		weekdayFormat.format(calendarDate(addDays('2024-01-01', index)))
	));
	const colors = ['var(--heatmap-empty)', '#a7f3d0', '#6ee7b7', '#10b981', '#047857'];
	const STEP = 15;
	const LEFT = 48;
	const TOP = 26;
	const width = $derived(LEFT + calendar.weeks * STEP + 4);

	function calendarDate(date: string): Date {
		return new Date(dayNumber(date)! * 86_400_000);
	}

	function level(seconds: number): number {
		return seconds > 0 && peak > 0 ? Math.max(1, Math.ceil(seconds / peak * 4)) : 0;
	}

	function exactDuration(seconds: number): string {
		const parts = durationParts(seconds);
		return `${m['stats.duration.hours_minutes']({ hours: parts.hours, minutes: parts.minutes })} ${m['stats.duration.seconds']({ seconds: parts.seconds })}`;
	}

	function hours(seconds: number): string {
		return m['stats.reading.hours']({ hours: numbers.format(seconds / 3600) });
	}
</script>

<div class="reading-heatmap">
	<figure aria-label={m['stats.reading.heatmap_label']()}>
		<div class="calendar-scroll">
			<svg
				viewBox={`0 0 ${width} ${TOP + STEP * 7}`}
				style:min-width={`${width}px`}
				role="img"
				aria-label={m['stats.reading.heatmap_label']()}
			>
				{#each months as month (month.date)}
					<text x={LEFT + month.week * STEP} y="14" class="axis">
						{monthFormat.format(calendarDate(month.date))}
					</text>
				{/each}
				{#each weekdays as weekday, index}
					<text x={LEFT - 8} y={TOP + index * STEP + 10} text-anchor="end" class="axis">{weekday}</text>
				{/each}
				{#each daily as day (day.date)}
					<rect
						x={LEFT + day.week * STEP}
						y={TOP + day.weekday * STEP}
						width="12"
						height="12"
						rx="2"
						fill={colors[level(day.active_seconds)]}
						class="day"
						data-date={day.date}
						data-seconds={day.active_seconds}
					>
						<title>{formatCalendar(day.date, locale)} ({day.date}): {exactDuration(day.active_seconds)}</title>
					</rect>
				{/each}
			</svg>
		</div>
		<figcaption class="legend">
			<span>{m['stats.reading.less']()}</span>
			{#each colors as color}<span class="swatch" style:background={color} aria-hidden="true"></span>{/each}
			<span>{m['stats.reading.more']()}</span>
		</figcaption>
	</figure>

	{#if summary.activeDays === 0}
		<p class="empty">{m['stats.daily.empty']()}</p>
	{/if}

	<details class="daily-table">
		<summary>{m['stats.reading.daily_table']()}</summary>
		<div class="table-scroll">
			<table>
				<caption>{m['stats.daily.table_caption']()}</caption>
				<thead>
					<tr>
						<th scope="col">{m['stats.table.date']()}</th>
						<th scope="col">{m['stats.table.time']()}</th>
						<th scope="col">{m['stats.table.sessions']()}</th>
					</tr>
				</thead>
				<tbody>
					{#each daily as day (day.date)}
						<tr>
							<th scope="row"><time datetime={day.date}>{formatCalendar(day.date, locale)}</time></th>
							<td>{exactDuration(day.active_seconds)}</td>
							<td>{counts.format(day.session_count)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</details>

	<dl class="summary">
		<div><dt>{m['stats.reading.days']()}</dt><dd>{counts.format(summary.activeDays)}</dd></div>
		<div><dt>{m['stats.reading.total_hours']()}</dt><dd>{hours(summary.activeSeconds)}</dd></div>
		<div><dt>{m['stats.reading.average_hours']()}</dt><dd>{hours(summary.activeDays ? summary.activeSeconds / summary.activeDays : 0)}</dd></div>
		<div><dt>{m['stats.reading.read_books']()}</dt><dd>{counts.format(data.books.read)}</dd></div>
		<div><dt>{m['stats.reading.read_and_reading_books']()}</dt><dd>{counts.format(data.books.read_and_reading)}</dd></div>
	</dl>
</div>

<style>
	.reading-heatmap { --heatmap-empty: var(--shell-hover, #e2e8f0); min-width: 0; color: var(--shell-text, #1f2328); }
	figure { margin: 0; }
	.calendar-scroll { max-width: 100%; overflow-x: auto; padding-bottom: 0.375rem; }
	svg { display: block; width: 100%; height: auto; }
	.axis { fill: var(--shell-muted, #56657a); font-size: 10px; }
	.day { stroke: var(--shell-border, #dde2e8); stroke-width: 0.5; }
	.day:hover { stroke: var(--shell-text, #1f2328); stroke-width: 1.5; }
	.legend { display: flex; align-items: center; justify-content: flex-end; gap: 0.25rem; margin-top: 0.375rem; font-size: 0.75rem; color: var(--shell-muted, #56657a); }
	.swatch { width: 0.75rem; height: 0.75rem; border-radius: 2px; border: 0.5px solid var(--shell-border, #dde2e8); }
	.empty { margin: 0.75rem 0; font-size: 0.875rem; color: var(--shell-muted, #56657a); }
	.daily-table { margin-top: 0.75rem; font-size: 0.8125rem; }
	.daily-table summary { width: fit-content; cursor: pointer; }
	.daily-table summary:focus-visible { outline: 2px solid var(--shell-active, #047857); outline-offset: 3px; }
	.table-scroll { overflow: auto; max-height: 22rem; margin-top: 0.5rem; }
	table { width: 100%; border-collapse: collapse; text-align: start; }
	caption { text-align: start; padding: 0.5rem 0; color: var(--shell-muted, #56657a); }
	th, td { padding: 0.5rem; border-bottom: 1px solid var(--shell-border, #dde2e8); white-space: nowrap; }
	tbody th { font-weight: normal; }
	.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 1rem; margin: 1.25rem 0 0; padding-top: 1rem; border-top: 1px solid var(--shell-border, #dde2e8); }
	dt { color: var(--shell-muted, #56657a); font-size: 0.75rem; }
	dd { margin: 0.375rem 0 0; font-size: 1.125rem; font-weight: 600; }
</style>
