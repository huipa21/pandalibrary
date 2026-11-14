<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatCalendar } from './api.js';
	import { completionMaximum, completionPoints, completionSummary, orderedCompletions, recordedProgress, steppedPath } from './reading-completion.js';
	import type { ReadingCompletion, ReadingProgressPoint, ReadingStats } from './reading-types.js';

	interface Props {
		data: ReadingStats;
	}

	let { data }: Props = $props();
	const locale = $derived(getLocale());
	const numbers = $derived(new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }));
	const completions = $derived(orderedCompletions(data.completions));
	const summary = $derived(completionSummary(completions));
	const maximum = $derived(completionMaximum(completions));
	const ticks = $derived([...new Set([0, Math.round(maximum / 2), maximum])]);
	const series = $derived(completions.map((completion, index) => ({
		completion,
		color: `hsl(${(index * 137.508 + 210) % 360} 65% 38%)`,
		points: completionPoints(completion, maximum)
	})).filter((item) => item.points.length));
	let hovered = $state<{ book: ReadingCompletion; progress: ReadingProgressPoint } | null>(null);
	const active = $derived(hovered && completions.includes(hovered.book) ? hovered : null);

	function days(value: number) {
		return m['stats.reading.days_value']({ days: numbers.format(value) });
	}

	function tooltip(completion: ReadingCompletion, progress: ReadingProgressPoint) {
		return `${completion.title} · ${formatCalendar(progress.recorded_on, locale)} · ${m['stats.reading.days_since_first_session']()}: ${numbers.format(progress.days)} · ${m['stats.reading.progress_percent']()}: ${numbers.format(progress.percentage * 100)}%`;
	}
</script>

<div class="completion-race">
	<dl class="summary">
		<div>
			<dt>{m['stats.reading.completed_books']()}</dt>
			<dd>{numbers.format(summary.count)}</dd>
		</div>
		{#if summary.count}
			<div><dt>{m['stats.reading.average_days']()}</dt><dd>{days(summary.average!)}</dd></div>
			<div><dt>{m['stats.reading.median_days']()}</dt><dd>{days(summary.median!)}</dd></div>
			<div><dt>{m['stats.reading.fastest_days']()}</dt><dd>{days(summary.fastest!)}</dd></div>
			<div><dt>{m['stats.reading.slowest_days']()}</dt><dd>{days(summary.slowest!)}</dd></div>
		{/if}
	</dl>

	{#if !summary.count}
		<p class="empty">{m['stats.reading.race_empty']()}</p>
	{:else}
		{#if series.length}
		<figure>
			<p class="axis-label">{m['stats.reading.progress_percent']()}</p>
			<svg viewBox="0 0 640 240" role="group" aria-label={m['stats.reading.race_label']()}>
				<title>{m['stats.reading.race_label']()}</title>
				<desc>{m['stats.reading.race_hint']()}</desc>
				{#each [0, 25, 50, 75, 100] as tick}
					<line x1="70" y1={196 - tick / 100 * 180} x2="620" y2={196 - tick / 100 * 180} class="grid-line" />
					<text x="62" y={200 - tick / 100 * 180} text-anchor="end">{numbers.format(tick)}%</text>
				{/each}
				<g transform="translate(70,16)">
					{#each series as item (item.completion.book_id)}
						<g class="book-series" data-book-id={item.completion.book_id} style:--series-color={item.color}>
							<path d={steppedPath(item.points)} class="race-line" vector-effect="non-scaling-stroke" />
							{#each item.points as point}
								<circle cx={point.x} cy={point.y} r="4" class="point" tabindex="0"
									role="button" aria-label={tooltip(item.completion, point.progress)}
									onclick={() => hovered = { book: item.completion, progress: point.progress }}
									onkeydown={(event) => {
										if (event.key === 'Escape') hovered = null;
										if (event.key === 'Enter' || event.key === ' ') {
											event.preventDefault();
											hovered = { book: item.completion, progress: point.progress };
										}
									}}
									onpointerenter={() => hovered = { book: item.completion, progress: point.progress }}
									onpointerleave={() => hovered = null}
									onfocus={() => hovered = { book: item.completion, progress: point.progress }}
									onblur={() => hovered = null}>
									<title>{tooltip(item.completion, point.progress)}</title>
								</circle>
							{/each}
						</g>
					{/each}
				</g>
				{#each ticks as tick}
					<text x={70 + tick / Math.max(1, maximum) * 550} y="216" text-anchor="middle">{numbers.format(tick)}</text>
				{/each}
				<text x="345" y="236" text-anchor="middle">{m['stats.reading.days_since_first_session']()}</text>
			</svg>
			{#if active}
				<div role="tooltip" class="tooltip">{tooltip(active.book, active.progress)}</div>
			{/if}
			<ul class="legend">
				{#each series as item (item.completion.book_id)}
					<li><span class="swatch" style:background={item.color}></span><a href={`/books/${item.completion.book_id}`}>{item.completion.title}</a></li>
				{/each}
			</ul>
		</figure>
		{:else}
			<p class="empty">{m['stats.reading.race_no_progress']()}</p>
		{/if}

		<details class="data-table">
			<summary>{m['stats.reading.completion_table']()}</summary>
			<div class="scroll">
				<table>
					<caption>{m['stats.reading.completion_table']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['stats.reading.completion_order']()}</th>
							<th scope="col">{m['stats.table.book']()}</th>
							<th scope="col">{m['stats.reading.started']()}</th>
							<th scope="col">{m['stats.reading.finished']()}</th>
							<th scope="col">{m['stats.reading.duration']()}</th>
							<th scope="col">{m['stats.reading.progress_percent']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each completions as completion, index (completion.book_id)}
							<tr>
								<td class="numeric">{numbers.format(index + 1)}</td>
								<th scope="row"><a href={`/books/${completion.book_id}`}>{completion.title}</a></th>
								<td><time datetime={completion.started_on}>{formatCalendar(completion.started_on, locale)}</time></td>
								<td><time datetime={completion.finished_on}>{formatCalendar(completion.finished_on, locale)}</time></td>
								<td class="numeric">{days(completion.days)}</td>
								<td>
									<ul class="progress-values">
										{#each recordedProgress(completion) as point}
											<li><time datetime={point.recorded_on}>{formatCalendar(point.recorded_on, locale)}</time> · {days(point.days)} · {numbers.format(point.percentage * 100)}%</li>
										{/each}
									</ul>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
	{/if}
</div>

<style>
	.completion-race { min-width: 0; color: #475569; font-size: .8125rem; }
	.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .75rem; margin-bottom: 1.25rem; }
	dt { color: #64748b; font-size: .75rem; }
	dd { margin-top: .25rem; font-weight: 600; font-size: 1.125rem; color: #334155; font-variant-numeric: tabular-nums; }
	figure { margin: 0; position: relative; }
	.axis-label { color: #64748b; font-size: .75rem; }
	svg { display: block; width: 100%; height: auto; overflow: visible; }
	svg text { fill: #64748b; font-size: 11px; }
	.grid-line { stroke: #e2e8f0; vector-effect: non-scaling-stroke; }
	.race-line { fill: none; stroke: var(--series-color); stroke-width: 2; }
	.point { fill: var(--series-color); stroke: white; stroke-width: 1; }
	.point:hover, .point:focus { r: 6; stroke: #0f172a; stroke-width: 2; outline: none; }
	.legend { display: flex; flex-wrap: wrap; gap: .5rem 1rem; padding: 0; margin: .75rem 0 0; list-style: none; }
	.legend li { display: flex; gap: .375rem; align-items: baseline; overflow-wrap: anywhere; min-width: 0; }
	.swatch { display: inline-block; flex: 0 0 .75rem; width: .75rem; height: .2rem; align-self: center; }
	.tooltip { position: absolute; top: 0; right: 0; max-width: min(22rem, 90%); padding: .5rem .75rem; border: 1px solid #cbd5e1; border-radius: .375rem; background: white; box-shadow: 0 2px 6px #0002; pointer-events: none; overflow-wrap: anywhere; }
	.progress-values { margin: 0; padding: 0; list-style: none; font-variant-numeric: tabular-nums; }
	.empty { border: 1px dashed #cbd5e1; border-radius: 6px; padding: 1.5rem; text-align: center; color: #64748b; }
	.data-table { border-top: 1px solid #e2e8f0; padding-top: .75rem; }
	summary { cursor: pointer; color: #64748b; }
	a:focus-visible, summary:focus-visible { outline: 2px solid #0f172a; outline-offset: 3px; }
	a:hover { text-decoration: underline; }
	.scroll { max-width: 100%; overflow-x: auto; }
	table { width: 100%; border-collapse: collapse; margin-top: .75rem; text-align: left; }
	caption { text-align: left; font-weight: 600; margin-bottom: .5rem; }
	th, td { padding: .5rem; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
	thead th { color: #64748b; font-weight: 500; }
	tbody th { min-width: 9rem; font-weight: 500; overflow-wrap: anywhere; }
	time { white-space: nowrap; }
	.numeric { font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
