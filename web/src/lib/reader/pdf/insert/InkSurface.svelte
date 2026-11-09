<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { PageLayerContext } from '../types.js';
	import { finishInk, inkBounds, samplePointer, strokePath } from './ink.js';
	import InkBar from './InkBar.svelte';
	import type { PageAnnotationInput } from '../../types.js';
	let { ctx, save, cancel, announce }: {
		ctx: PageLayerContext; save(input: PageAnnotationInput): void; cancel(): void; announce(message: string): void;
	} = $props();
	let strokes = $state<number[][]>([]), active = $state<number[]>([]);
	let pointer: number | null = null;
	let color = $state('#111827'), width = $state(0.004);
	function done() {
		const all = active.length ? [...strokes, active] : strokes;
		if (!all.length) { cancel(); return; }
		const data = finishInk(all, color, width);
		save({ kind: 'ink', locator: { type: 'pdf', page: ctx.page, rect: inkBounds(data.strokes) }, position: 0, data });
	}
	function discard(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault(); event.stopImmediatePropagation();
		if ((!strokes.length && !active.length) || confirm(m['pv9.discard_drawing']())) cancel();
	}
	onMount(() => {
		document.addEventListener('keydown', discard, true);
		return () => document.removeEventListener('keydown', discard, true);
	});
</script>
<div class="ink-surface" role="application" aria-label={m['pv9.draw']()}
	onpointerdown={(event) => {
		if (event.button !== 0 || pointer !== null) return;
		event.preventDefault(); event.stopPropagation();
		if (strokes.length >= 200) { announce(m['pv9.stroke_limit']()); return; }
		pointer = event.pointerId; event.currentTarget.setPointerCapture(pointer);
		active = samplePointer(event, ctx.fromClient);
	}}
	onpointermove={(event) => { if (pointer === event.pointerId) active = [...active, ...samplePointer(event, ctx.fromClient)]; }}
	onpointerup={(event) => {
		if (pointer !== event.pointerId) return;
		strokes = [...strokes, [...active, ...samplePointer(event, ctx.fromClient)]];
		active = []; pointer = null;
	}}
	onpointercancel={() => { active = []; pointer = null; }}>
	<svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
		{#each [...strokes, ...(active.length ? [active] : [])] as stroke}
			<path d={strokePath(stroke)} fill="none" stroke={color} stroke-width={width * ctx.width} vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
		{/each}
	</svg>
</div>
<div class="ink-controls"><InkBar bind:color bind:width count={strokes.length} undo={() => { strokes = strokes.slice(0, -1); }} {done} /></div>
<style>
	.ink-surface { position: absolute; inset: 0; pointer-events: auto; touch-action: none; cursor: crosshair; }
	svg { width: 100%; height: 100%; pointer-events: none; }
	.ink-controls { position: fixed; top: 4px; left: 4px; max-width: 100%; pointer-events: auto; }
</style>
