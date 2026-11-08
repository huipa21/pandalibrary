<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { barHeights, hasPositive } from './api.js';
	import type { Bar } from './types.js';

	interface Props {
		bars: readonly Bar[];
		/** Accessible summary; the companion table carries the full data. */
		label: string;
		empty: string;
	}

	let { bars, label, empty }: Props = $props();

	const HEIGHT = 100;
	const STEP = 10;
	const heights = $derived(barHeights(bars.map((bar) => bar.value), HEIGHT));
	const width = $derived(Math.max(bars.length, 1) * STEP);
</script>

{#if !hasPositive(bars.map((bar) => bar.value))}
	<p class="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">{empty}</p>
{:else}
	<figure class="space-y-1">
		<svg
			class="h-40 w-full card"
			viewBox={`0 0 ${width} ${HEIGHT}`}
			preserveAspectRatio="none"
			role="img"
			aria-label={label}
		>
			<line x1="0" y1={HEIGHT - 0.5} x2={width} y2={HEIGHT - 0.5} class="stroke-slate-300" stroke-width="1" vector-effect="non-scaling-stroke" />
			{#each bars as bar, index (bar.key)}
				<rect
					x={index * STEP + 1.5}
					y={HEIGHT - heights[index]}
					width={STEP - 3}
					height={heights[index]}
					class="fill-slate-700"
					data-value={bar.value}
				>
					<title>{m['stats.bar_title']({ label: bar.label, value: bar.display })}</title>
				</rect>
			{/each}
		</svg>
		<figcaption class="flex justify-between gap-4 text-xs text-slate-500" aria-hidden="true">
			<span>{bars[0]?.label}</span>
			{#if bars.length > 1}<span>{bars[bars.length - 1].label}</span>{/if}
		</figcaption>
	</figure>
{/if}
