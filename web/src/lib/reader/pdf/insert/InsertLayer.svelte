<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getPdfReaderContext } from '../context.js';
	import type { PageLayerContext, NormalizedPoint } from '../types.js';
	import type { NormalizedRect, PageAnnotation, PageAnnotationInput } from '../../types.js';
	import { pageAnnotationPainter } from './page-annotation-painter.js';
	import InsertMenu from './InsertMenu.svelte';
	import TextBoxEditor from './TextBoxEditor.svelte';
	import InkSurface from './InkSurface.svelte';
	import ImagePlacer from './ImagePlacer.svelte';
	import SelectionFrame from './selection-frame.svelte';
	import { pointRect } from './geometry-insert.js';
	import { finishInk } from './ink.js';

	const context = getPdfReaderContext();
	let ready = $state(false);
	let menu = $state<{ page: number; point: NormalizedPoint; x: number; y: number } | null>(null);
	let mode = $state<'text' | 'ink' | 'image' | null>(null);
	let target = $state<{ page: number; point: NormalizedPoint } | null>(null);
	let selected = $state<string | null>(null);
	let editing = $state<PageAnnotation | null>(null);
	let active = $state.raw<PageLayerContext | null>(null);
	let deleted = $state<PageAnnotation | null>(null);
	let undoTimer: ReturnType<typeof setTimeout>;
	let saving = $state(false);
	const contexts = new Map<number, PageLayerContext>();
	const row = $derived(context.controller.pageAnnotations.find((item) => item.id === selected));
	const painter = pageAnnotationPainter(
		() => context.controller.pageAnnotations, () => context.tool.current,
		(ctx) => {
			contexts.set(ctx.page, ctx);
			if (ctx.page === (target?.page ?? row?.locator.page)) active = ctx;
		},
		() => editing?.id
	);

	function portal(host: HTMLElement, ctx: PageLayerContext) {
		const node = host.firstElementChild;
		if (!(node instanceof HTMLElement)) throw new Error('Insert overlay is unavailable.');
		const place = (next: PageLayerContext) => {
			// A sibling survives the engine clearing painter children on every repaint.
			node.style.cssText = next.layer.style.cssText;
			node.style.zIndex = '9';
			if (node.parentNode !== next.layer.parentNode) {
				const focused = document.activeElement;
				node.dataset.pv9Moving = '';
				next.layer.parentNode?.appendChild(node);
				delete node.dataset.pv9Moving;
				if (focused instanceof HTMLElement && node.contains(focused)) focused.focus();
			};
		}
		place(ctx);
		return { update: place, destroy() { node.remove(); } };
	}
	function finish() {
		mode = null; target = null; editing = null; menu = null;
		context.tool.set(context.tool.previous);
	}
	async function save(input: PageAnnotationInput | null) {
		if (saving) return;
		if (!input) { finish(); return true; }
		saving = true;
		input.position = (input.locator.page - 1 + input.locator.rect.y) / context.view.pageCount;
		const success = editing ? await context.controller.updatePageAnnotation(editing, input) :
			await context.controller.addPageAnnotation(input);
		saving = false;
		if (success) finish();
		else context.announce(context.controller.actionError || m['pv9.save_failed']());
		return success;
	}
	function choose(kind: 'text' | 'ink' | 'image') {
		if (!menu) return;
		target = { page: menu.page, point: menu.point };
		active = contexts.get(menu.page) ?? null;
		selected = null; mode = kind; menu = null;
	}
	function edit(item: PageAnnotation) {
		if (item.kind !== 'text') return;
		editing = item; selected = null; target = { page: item.locator.page, point: item.locator.rect };
		active = contexts.get(item.locator.page) ?? null; mode = 'text';
	}
	async function update(item: PageAnnotation, rect: NormalizedRect) {
		if (saving) return;
		let patch: Partial<PageAnnotationInput> = { locator: { ...item.locator, rect },
			position: (item.locator.page - 1 + rect.y) / context.view.pageCount };
		if (item.kind === 'ink') {
			const dx = rect.x - item.locator.rect.x, dy = rect.y - item.locator.rect.y;
			const strokes = item.data.strokes.map((stroke) =>
				stroke.map((value, i) => Math.max(0, Math.min(1, value + (i % 2 ? dy : dx)))));
			patch = { locator: { ...item.locator, rect }, position: patch.position, kind: 'ink',
				data: finishInk(strokes, item.data.color, item.data.width) };
		}
		saving = true;
		const success = await context.controller.updatePageAnnotation(item, patch);
		saving = false;
		if (!success) context.announce(context.controller.actionError || m['pv9.save_failed']());
	}
	async function remove(item: PageAnnotation) {
		if (saving) return;
		saving = true;
		const success = await context.controller.removePageAnnotation(item);
		saving = false;
		if (!success) { context.announce(context.controller.actionError || m['pv9.save_failed']()); return; }
		selected = null; deleted = item; clearTimeout(undoTimer);
		undoTimer = setTimeout(() => { deleted = null; }, 6000);
	}
	async function undo() {
		if (!deleted || saving) return;
		saving = true;
		const success = await context.controller.restorePageAnnotation(deleted);
		saving = false;
		if (success) { deleted = null; clearTimeout(undoTimer); }
		else context.announce(context.controller.actionError || m['pv9.save_failed']());
	}
	function itemFrom(event: Event) {
		const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-annotation-id]') : null;
		return context.controller.pageAnnotations.find((item) => item.id === element?.dataset.annotationId);
	}
	onMount(() => {
		const unregister = context.engine.pageLayers.register(painter);
		const surface = context.engine.viewport;
		function click(event: MouseEvent) {
			if (context.tool.current === 'hand' || mode || event.defaultPrevented) return;
			const item = itemFrom(event);
			if (item) {
				event.stopPropagation(); selected = item.id; active = contexts.get(item.locator.page) ?? null;
				if (event.detail === 2) edit(item);
				return;
			}
			if (event.target instanceof Element && event.target.closest('.pv9-overlay, button, a, input')) return;
			selected = null;
			if (context.tool.current !== 'insert') return;
			const hit = context.engine.hitTest(event.clientX, event.clientY);
			if (hit) { event.preventDefault(); menu = { ...hit, x: event.clientX, y: event.clientY }; }
		}
		function key(event: KeyboardEvent) {
			const item = itemFrom(event);
			if (!item || context.tool.current === 'hand') return;
			if (event.key === 'Delete' || event.key === 'Backspace') {
				event.preventDefault(); event.stopPropagation(); void remove(item);
			} else if (event.key.startsWith('Arrow')) {
				event.preventDefault(); event.stopPropagation();
				selected = item.id; active = contexts.get(item.locator.page) ?? null;
				const step = event.shiftKey ? 0.05 : 0.005;
				void update(item, pointRect({ x: item.locator.rect.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
					y: item.locator.rect.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) }, item.locator.rect.width, item.locator.rect.height));
			} else if (event.key === 'Enter' && item.kind === 'text') { event.preventDefault(); edit(item); }
		}
		surface.addEventListener('click', click);
		surface.addEventListener('keydown', key);
		ready = true;
		return () => {
			clearTimeout(undoTimer); surface.removeEventListener('click', click); surface.removeEventListener('keydown', key);
			unregister(); painter.dispose(); contexts.clear();
		};
	});
	$effect(() => {
		painter.refresh();
		if (ready) untrack(() => context.engine.pageLayers.repaint());
	});
	$effect(() => {
		if (context.tool.current === 'hand') { selected = null; menu = null; }
	});
	$effect(() => {
		return context.controller.registerDraftGuard(() => !mode || confirm(m['pv9.discard_insert']()));
	});
</script>

{#if menu}<InsertMenu {...menu} offline={context.offline} {choose} cancel={() => { menu = null; }} />{/if}
{#if active && (mode || row && context.tool.current !== 'hand')}
	<div use:portal={active}>
		<div class="pv9-overlay">
			{#if mode === 'text' && target}
				<TextBoxEditor ctx={active} point={target.point} initial={editing?.kind === 'text' ? editing.data : undefined} {save} />
			{:else if mode === 'ink'}
				<InkSurface ctx={active} {save} cancel={finish} announce={context.announce} />
			{:else if mode === 'image' && target}
				<ImagePlacer ctx={active} point={target.point} {save} cancel={finish} announce={context.announce} />
			{:else if row}
				<SelectionFrame {row} ctx={active} update={(rect) => update(row, rect)} remove={() => remove(row)} edit={() => edit(row)} />
			{/if}
		</div>
	</div>
{/if}
{#if deleted}
	<div class="pv9-toast" role="status">{m['pv9.deleted']()} <button onclick={undo} disabled={saving}>{m['pv9.undo']()}</button></div>
{/if}
<style>
	.pv9-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
	:global(.pv9-bar) { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px; background: var(--pv-chrome, white); color: var(--shell-text, #111827); border: 1px solid #888; border-radius: 4px; font: 13px sans-serif; }
	:global(.pv9-bar button), :global(.pv9-bar select) { padding: 4px; }
	.pv9-toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 100; padding: 10px; background: var(--pv-chrome, white); color: var(--shell-text, #111827); border: 1px solid #888; border-radius: 4px; }
</style>
