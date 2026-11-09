<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { PageLayerContext, NormalizedPoint } from '../types.js';
	import type { PageAnnotationInput, TextData } from '../../types.js';
	import { pointRect } from './geometry-insert.js';
	let { ctx, point, initial, save }: {
		ctx: PageLayerContext; point: NormalizedPoint; initial?: TextData;
		save(input: PageAnnotationInput | null): Promise<boolean | undefined>;
	} = $props();
	const seed = untrack(() => initial);
	let text = $state(seed?.text ?? ''), color = $state(seed?.color ?? '#111827'), size = $state(seed?.size ?? 0.018);
	let textarea: HTMLTextAreaElement;
	let measured = $state({ width: 0.25, height: 0.04 });
	let committed = false;
	const rect = $derived(pointRect(point, measured.width, measured.height));
	async function measure(pageWidth = ctx.width, pageHeight = ctx.height, textSize = size) {
		await tick();
		if (!textarea) return;
		textarea.style.whiteSpace = 'pre';
		textarea.style.width = '1px'; textarea.style.height = '1px';
		const width = Math.min(pageWidth * (1 - Math.min(point.x, 0.95)), Math.max(40, textarea.scrollWidth + 4));
		textarea.style.width = `${width}px`;
		textarea.style.whiteSpace = 'pre-wrap';
		const height = Math.min(pageHeight, Math.max(textSize * pageHeight * 1.2 + 4, textarea.scrollHeight + 4));
		textarea.style.height = `${height}px`;
		measured = { width: width / pageWidth, height: height / pageHeight };
	}
	async function commit() {
		if (committed) return;
		committed = true;
		const success = await save(text.trim() ? { kind: 'text', locator: { type: 'pdf', page: ctx.page, rect }, position: 0, data: { text, color, size } } : null);
		if (!success) committed = false;
	}
	onMount(() => textarea.focus());
	$effect(() => { void measure(ctx.width, ctx.height, size); });
</script>
<div class="text-editor" role="dialog" tabindex="-1" aria-label={m['pv9.text']()} style:left={`${rect.x * 100}%`} style:top={`${rect.y * 100}%`}
	onfocusout={(event) => {
		if (!event.currentTarget.isConnected || event.currentTarget.closest('[data-pv9-moving]')) return;
		if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) void commit();
	}}
	onkeydown={(event) => {
		if (event.key === 'Escape' || event.key === 'Enter' && event.ctrlKey) {
			event.preventDefault(); event.stopImmediatePropagation(); commit();
		}
	}}>
	<div class="pv9-bar" role="toolbar" aria-label={m['pv9.text']()}
		style:bottom={rect.y * ctx.height >= 38 ? '100%' : undefined}
		style:top={rect.y * ctx.height < 38 ? '100%' : undefined}
		style:left={`${-Math.max(0, rect.x * ctx.width + 300 - ctx.width)}px`}>
		<label>{m['pv9.size']()} <select bind:value={size}><option value={0.012}>S</option><option value={0.018}>M</option><option value={0.028}>L</option></select></label>
		<label>{m['pv9.color']()} <select bind:value={color}>
			{#each ['#111827', '#dc2626', '#2563eb', '#16a34a', '#ea580c', '#7c3aed'] as value}<option value={value}>{value}</option>{/each}
		</select></label>
		<button onclick={commit}>{m['pv9.done']()}</button>
	</div>
	<textarea bind:this={textarea} bind:value={text} maxlength="4000" aria-label={m['pv9.text']()} oninput={() => measure()}
		style:font-size={`${size * ctx.height}px`} style:color={color}></textarea>
</div>
<style>
	.text-editor { position: absolute; pointer-events: auto; }
	.pv9-bar { position: absolute; left: 0; white-space: nowrap; }
	textarea { display: block; resize: none; padding: 0; border: 1px dashed #2563eb; line-height: 1.2; background: #ffffffee; overflow: auto; overflow-wrap: anywhere; }
</style>
