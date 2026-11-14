<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatCalendar } from './api.js';
	import { completionPoints, completionSummary, orderedCompletions, steppedPath } from './reading-completion.js';
	import type { ReadingCompletion, ReadingStats } from './reading-types.js';

	interface Props {
		data: ReadingStats;
	}

	let { data }: Props = $props();
	const locale = $derived(getLocale());
	const numbers = $derived(new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }));
	const completions = $derived(orderedCompletions(data.completions));
	const summary = $derived(completionSummary(completions));
	const points = $derived(completionPoints(completions));
	const path = $derived(steppedPath(points));
	const maximum = $derived(Math.max(1, summary.slowest ?? 0));
	const ticks = $derived(summary.slowest === 0 ? [0] : [0, maximum / 2, maximum]);

	function days(value: number) {
		return m['stats.reading.days_value']({ days: numbers.format(value) });
	}

	function tooltip(completion: ReadingCompletion, index: number) {
		return `${m['stats.reading.completion_order']()}: ${numbers.format(index + 1)} · ${completion.title} · ${m['stats.reading.started']()}: ${formatCalendar(completion.started_on, locale)} · ${m['stats.reading.finished']()}: ${formatCalendar(completion.finished_on, locale)} · ${days(completion.days)}`;
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
		<figure>
			<p class="axis-label">{m['stats.reading.duration']()}</p>
			<svg viewBox="0 0 640 240" role="img" aria-label={m['stats.reading.race_label']()}>
				<title>{m['stats.reading.race_label']()}</title>
				<desc>{m['stats.reading.race_hint']()}</desc>
				{#each ticks as tick}
					<line x1="70" y1={196 - tick / maximum * 180} x2="620" y2={196 - tick / maximum * 180} class="grid-line" />
					<text x="62" y={200 - tick / maximum * 180} text-anchor="end">{days(tick)}</text>
				{/each}
				<g transform="translate(70,16)">
					<path d={path} class="race-line" vector-effect="non-scaling-stroke" />
					{#each completions as completion, index (completion.book_id)}
						<circle cx={points[index].x} cy={points[index].y} r="4" class="point">
							<title>{tooltip(completion, index)}</title>
						</circle>
					{/each}
				</g>
				<text x={completions.length === 1 ? 345 : 70} y="216" text-anchor="middle">{numbers.format(1)}</text>
				{#if completions.length > 1}
					<text x="620" y="216" text-anchor="middle">{numbers.format(completions.length)}</text>
				{/if}
				<text x="345" y="236" text-anchor="middle">{m['stats.reading.completion_order']()}</text>
			</svg>
			<figcaption>{m['stats.reading.race_hint']()}</figcaption>
		</figure>

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
	figure { margin: 0; }
	.axis-label, figcaption { color: #64748b; font-size: .75rem; }
	svg { display: block; width: 100%; height: auto; overflow: visible; }
	svg text { fill: #64748b; font-size: 11px; }
	.grid-line { stroke: #e2e8f0; vector-effect: non-scaling-stroke; }
	.race-line { fill: none; stroke: #475569; stroke-width: 2; }
	.point { fill: #475569; stroke: white; stroke-width: 1; }
	.point:hover { fill: #0f766e; r: 6; }
	figcaption { margin: .5rem 0 1rem; overflow-wrap: anywhere; }
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
