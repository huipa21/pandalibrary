<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { PageAnnotation, NormalizedRect } from '../../types.js';
	import type { PageLayerContext } from '../types.js';
	import { pointRect, resizeImage } from './geometry-insert.js';
	let { row, ctx, update, remove, edit }: {
		row: PageAnnotation; ctx: PageLayerContext;
		update(rect: NormalizedRect): void; remove(): void; edit(): void;
	} = $props();
	let preview = $state<NormalizedRect | null>(null);
	let frame: HTMLDivElement;
	onMount(() => frame.focus({ preventScroll: true }));
	let drag: { id: number; x: number; y: number; corner: string; rect: NormalizedRect } | null = null;
	const rect = $derived(preview ?? row.locator.rect);
	function down(event: PointerEvent, corner = '') {
		if (event.button !== 0 || drag) return;
		event.preventDefault(); event.stopPropagation();
		const point = ctx.fromClient(event.clientX, event.clientY);
		drag = { id: event.pointerId, ...point, corner, rect: row.locator.rect };
		event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId);
	}
	function move(event: PointerEvent) {
		if (!drag || drag.id !== event.pointerId) return;
		const point = ctx.fromClient(event.clientX, event.clientY);
		preview = drag.corner ? resizeImage(drag.rect, point, drag.corner, ctx.width, ctx.height) :
			pointRect({ x: drag.rect.x + point.x - drag.x, y: drag.rect.y + point.y - drag.y }, drag.rect.width, drag.rect.height);
	}
	function up(event: PointerEvent) {
		if (!drag || drag.id !== event.pointerId) return;
		if (preview) update(preview);
		drag = null; preview = null;
	}
	function key(event: KeyboardEvent) {
		if (event.target instanceof Element && event.target.closest('button')) return;
		if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault(); event.stopPropagation(); remove(); return;
		}
		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
		event.preventDefault(); event.stopPropagation();
		const step = event.shiftKey ? 0.05 : 0.005;
		update(pointRect({
			x: rect.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
			y: rect.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)
		}, rect.width, rect.height));
	}
</script>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- Keyboard movement applies to the whole annotation group. -->
<div bind:this={frame} class="selection-frame" role="group" aria-label={m['pv9.selection']()} tabindex="-1"
	style:left={`${rect.x * 100}%`} style:top={`${rect.y * 100}%`}
	style:width={`${rect.width * 100}%`} style:height={`${rect.height * 100}%`}
	onpointerdown={(event) => down(event)} onpointermove={move} onpointerup={up}
	onpointercancel={() => { drag = null; preview = null; }} onkeydown={key}
	ondblclick={(event) => { event.stopPropagation(); edit(); }}>
	<div class="pv9-bar" style:bottom={rect.y * ctx.height >= 38 ? 'calc(100% + 4px)' : undefined}
		style:top={rect.y * ctx.height < 38 ? 'calc(100% + 4px)' : undefined}>
		{#if row.kind === 'text'}<button onpointerdown={(event) => event.stopPropagation()} onclick={edit}>{m['pv9.edit']()}</button>{/if}
		<button onpointerdown={(event) => event.stopPropagation()} onclick={remove}>{m['pv9.delete']()}</button>
	</div>
	{#if row.kind === 'image'}
		{#each ['nw', 'ne', 'sw', 'se'] as corner}
			<button class="handle {corner}" aria-label={m['pv9.resize']({ corner })} onpointerdown={(event) => down(event, corner)}
				onpointermove={move} onpointerup={up} onpointercancel={() => { drag = null; preview = null; }}></button>
		{/each}
	{/if}
</div>
<style>
	.selection-frame { position: absolute; border: 1px dashed #2563eb; pointer-events: auto; touch-action: none; cursor: move; box-sizing: border-box; }
	.pv9-bar { position: absolute; left: 0; white-space: nowrap; }
	.handle { position: absolute; width: 14px; height: 14px; padding: 0; background: white; border: 2px solid #2563eb; touch-action: none; }
	.nw { top: -7px; left: -7px; cursor: nwse-resize; } .ne { top: -7px; right: -7px; cursor: nesw-resize; }
	.sw { bottom: -7px; left: -7px; cursor: nesw-resize; } .se { bottom: -7px; right: -7px; cursor: nwse-resize; }
</style>
