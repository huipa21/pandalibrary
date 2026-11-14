<script lang="ts">
	import type { ChartDatum } from './book-types.js';
	import { areaPath, chartPositions, chartWeights, pieSlices, treemapRects } from './chart-geometry.js';

	interface Props {
		data: readonly ChartDatum[];
		kind: 'bar' | 'area' | 'treemap' | 'pie';
		label: string;
		empty: string;
		interaction?: 'hover' | 'click';
		showValues?: boolean;
		tableLabel?: string;
	}

	let { data, kind, label, empty, interaction = 'hover', showValues = false, tableLabel = label }: Props = $props();
	let hovered = $state<string | null>(null);
	let focused = $state<string | null>(null);
	let selected = $state<string | null>(null);
	const weights = $derived(chartWeights(data.map((datum) => datum.value)));
	const hasData = $derived(weights.some((weight) => weight > 0));
	const recordedData = $derived(data.filter((datum) => datum.value > 0));
	const rectangles = $derived(treemapRects(data.map((datum) => datum.value), 100, 70));
	const slices = $derived(pieSlices(data.map((datum) => datum.value)));
	const positions = $derived(chartPositions(data.map((datum) => datum.key)));
	const areaLabels = $derived.by(() => {
		const result = new Set<number>();
		const spacing = 60 / Math.max(320, data.length * 64);
		let previous = -1;
		for (let index = 0; index < positions.length; index++) {
			if (index === positions.length - 1) {
				if (previous > 0 && positions[index] - positions[previous] < spacing) result.delete(previous);
				result.add(index);
			} else if (previous === -1 || positions[index] - positions[previous] >= spacing) {
				result.add(index);
				previous = index;
			}
		}
		return result;
	});
	const boundaries = $derived([0, ...positions.slice(1).map((position, index) => (position + positions[index]) / 2), 1]);
	const area = $derived(areaPath(data.map((datum) => datum.value), 640, 200, positions));
	const detail = $derived(data.find((datum) => datum.key === (hovered ?? focused ?? (interaction === 'click' ? selected : null))));
	const colors = ['#475569', '#64748b', '#0f766e', '#647c72', '#a16207', '#7c6e91', '#587a91', '#8b6b60'];

	function select(key: string) {
		if (interaction === 'click') selected = selected === key ? null : key;
	}
</script>

<figure class="distribution" aria-label={label}>
	{#if !hasData}
		<p class="empty">{empty}</p>
	{:else}
		{#if kind === 'bar' || kind === 'area'}
			<div class="scroll">
				<div class="plot-group" style:min-width={`${Math.max(data.length * 64, 0)}px`}>
					<div class="plot">
						{#if kind === 'area'}
							<svg viewBox="0 -12 640 212" preserveAspectRatio="none" aria-hidden="true">
								<path d={area} fill="#cbd5e1" stroke="#475569" stroke-width="2" vector-effect="non-scaling-stroke" />
							</svg>
						{/if}
						<div class="columns" style:grid-template-columns={`repeat(${data.length}, minmax(0, 1fr))`}>
							{#each data as datum, index (datum.key)}
								<button
									type="button"
									class:area-control={kind === 'area'}
									class:bar-control={kind === 'bar'}
									style:left={kind === 'area' ? `${boundaries[index] * 100}%` : undefined}
									style:width={kind === 'area' ? `${(boundaries[index + 1] - boundaries[index]) * 100}%` : undefined}
									aria-label={`${datum.label}: ${datum.display}`}
									aria-pressed={interaction === 'click' ? selected === datum.key : undefined}
									onpointerenter={() => hovered = datum.key}
									onpointerleave={() => hovered = null}
									onfocus={() => focused = datum.key}
									onblur={() => focused = null}
									onclick={() => select(datum.key)}
								>
									{#if kind === 'bar'}
										<span class="bar" style:height={`${weights[index] * 85}%`}>
											{#if showValues}<span class="value">{datum.display}</span>{/if}
										</span>
									{:else}
										<span class="point" style:left={`${(positions[index] - boundaries[index]) / (boundaries[index + 1] - boundaries[index]) * 100}%`} style:bottom={`${weights[index] * 94.34}%`}></span>
									{/if}
								</button>
							{/each}
						</div>
					</div>
					<div class="axis" class:area-axis={kind === 'area'} style:grid-template-columns={`repeat(${data.length}, minmax(0, 1fr))`} aria-hidden="true">
						{#each data as datum, index (datum.key)}
							{#if kind !== 'area' || areaLabels.has(index)}
								<span style:left={kind === 'area' ? `${positions[index] * 100}%` : undefined}>{datum.label}</span>
							{/if}
						{/each}
					</div>
				</div>
			</div>
		{:else if kind === 'treemap'}
			<div class="treemap">
				{#each rectangles as rect (data[rect.index].key)}
					{@const datum = data[rect.index]}
					<button
						type="button"
						class="tile"
						style:left={`${rect.x}%`}
						style:top={`${rect.y / 70 * 100}%`}
						style:width={`${rect.width}%`}
						style:height={`${rect.height / 70 * 100}%`}
						style:background={colors[rect.index % colors.length]}
						aria-pressed={interaction === 'click' ? selected === datum.key : undefined}
						onpointerenter={() => hovered = datum.key}
						onpointerleave={() => hovered = null}
						onfocus={() => focused = datum.key}
						onblur={() => focused = null}
						onclick={() => select(datum.key)}
					>
						<span>{datum.label}</span><strong>{datum.display}</strong>
					</button>
				{/each}
			</div>
		{:else}
			<div class="pie-layout">
				<svg class="pie" viewBox="0 0 200 200" role="group" aria-label={label}>
					{#each slices as slice (data[slice.index].key)}
						<path
							d={slice.path}
							fill={colors[slice.index % colors.length]}
							stroke="white"
							stroke-width="1.5"
							role="button"
							tabindex="0"
							aria-label={`${data[slice.index].label}: ${data[slice.index].display}`}
							aria-pressed={interaction === 'click' ? selected === data[slice.index].key : undefined}
							class:active={detail?.key === data[slice.index].key}
							onpointerenter={() => hovered = data[slice.index].key}
							onpointerleave={() => hovered = null}
							onfocus={() => focused = data[slice.index].key}
							onblur={() => focused = null}
							onclick={() => select(data[slice.index].key)}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									select(data[slice.index].key);
								}
							}}
						/>
					{/each}
				</svg>
				<div class="legend" role="group" aria-label={label}>
					{#each data as datum, index (datum.key)}
						<button
							type="button"
							aria-label={`${datum.label}: ${datum.display}`}
							aria-pressed={interaction === 'click' ? selected === datum.key : undefined}
							onpointerenter={() => hovered = datum.key}
							onpointerleave={() => hovered = null}
							onfocus={() => focused = datum.key}
							onblur={() => focused = null}
							onclick={() => select(datum.key)}
						>
							<span class="swatch" style:background={colors[index % colors.length]}></span>
							<span class="legend-label">{datum.label}</span>
							<strong>{datum.display}</strong>
						</button>
					{/each}
				</div>
			</div>
		{/if}
		<div class="detail" role="status" aria-live="polite" aria-atomic="true">
			{#if detail}<span>{detail.label}</span><strong>{detail.display}</strong>{/if}
		</div>
	{/if}
	<details class="data-table">
		<summary>{tableLabel}</summary>
		<div class="scroll">
			<table>
				<caption>{label}</caption>
				<tbody>
					{#each recordedData as datum (datum.key)}
						<tr><th scope="row">{datum.label}</th><td>{datum.display}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</details>
</figure>

<style>
	.distribution { margin: 0; min-width: 0; font-size: 0.8125rem; color: #475569; }
	.scroll { overflow-x: auto; max-width: 100%; }
	.plot { position: relative; height: 220px; border-bottom: 1px solid #cbd5e1; }
	.plot svg { position: absolute; inset: 0; width: 100%; height: 100%; }
	.columns { position: absolute; inset: 0; display: grid; }
	button { cursor: pointer; font: inherit; }
	button:focus-visible { outline: 2px solid #0f172a; outline-offset: -2px; z-index: 1; }
	.columns button { position: relative; border: 0; background: transparent; padding: 0; min-width: 0; }
	.bar-control { display: flex; justify-content: center; align-items: flex-end; }
	.bar { position: relative; width: 65%; background: #64748b; border-radius: 3px 3px 0 0; }
	.bar-control:hover .bar, .bar-control:focus-visible .bar { background: #334155; }
	.value { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); padding-bottom: 5px; white-space: nowrap; font-size: 0.75rem; color: #334155; }
	.point { position: absolute; left: 50%; transform: translate(-50%, 50%); width: 7px; height: 7px; border-radius: 50%; background: #475569; }
	.area-control:hover, .area-control:focus-visible { background: rgb(100 116 139 / 10%); }
	.columns button.area-control { position: absolute; top: 0; bottom: 0; }
	.axis { display: grid; gap: 0; margin-top: 0.5rem; }
	.axis span { padding: 0 3px; text-align: center; overflow-wrap: anywhere; font-size: 0.6875rem; line-height: 1.4; }
	.area-axis { display: block; position: relative; min-height: 4rem; }
	.area-axis span { position: absolute; width: 60px; transform: translateX(-50%); }
	.treemap { position: relative; height: 260px; }
	.tile { position: absolute; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 0.25rem; overflow: hidden; border: 1px solid white; padding: 4px; color: white; }
	.tile span, .tile strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tile:hover, .tile:focus-visible { filter: brightness(1.15); }
	.pie-layout { display: flex; align-items: center; flex-wrap: wrap; gap: 1rem; }
	.pie { width: min(100%, 240px); height: auto; flex: 0 1 240px; margin: auto; }
	.pie path.active { stroke: #0f172a; stroke-width: 3; }
	.pie path { cursor: pointer; }
	.pie path:focus-visible { outline: none; stroke: #0f172a; stroke-width: 3; }
	.legend { min-width: 0; flex: 1 1 180px; display: grid; gap: 0.25rem; }
	.legend button { display: flex; align-items: center; gap: 0.5rem; min-width: 0; width: 100%; text-align: left; border: 0; border-radius: 4px; background: transparent; padding: 0.375rem; color: #475569; }
	.legend button:hover, .legend button[aria-pressed='true'] { background: #f1f5f9; }
	.swatch { width: 0.625rem; height: 0.625rem; border-radius: 2px; flex-shrink: 0; }
	.legend-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
	.legend strong { font-weight: 500; text-align: right; overflow-wrap: anywhere; }
	.detail { display: flex; flex-wrap: wrap; gap: 0.375rem 0.75rem; align-items: center; min-height: 2.5rem; padding: 0.5rem 0; overflow-wrap: anywhere; }
	.detail strong { font-weight: 600; color: #334155; }
	.empty { border: 1px dashed #cbd5e1; border-radius: 6px; padding: 1.5rem; text-align: center; color: #64748b; }
	.data-table { border-top: 1px solid #e2e8f0; padding-top: 0.75rem; }
	summary { cursor: pointer; overflow-wrap: anywhere; color: #64748b; }
	summary:focus-visible { outline: 2px solid #0f172a; outline-offset: 2px; }
	table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; text-align: left; }
	caption { text-align: left; font-weight: 600; margin-bottom: 0.5rem; }
	th, td { padding: 0.375rem; border-bottom: 1px solid #f1f5f9; overflow-wrap: anywhere; }
	th { font-weight: 400; }
	td { text-align: right; }
</style>
