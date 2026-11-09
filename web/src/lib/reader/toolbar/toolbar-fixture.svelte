<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import ReaderToolbar from './ReaderToolbar.svelte';
	import PageCounter from './PageCounter.svelte';
	import ProgressLabel from './ProgressLabel.svelte';
	import ZoomMenu from './ZoomMenu.svelte';
	import LayoutMenu from './LayoutMenu.svelte';
	import RotateMenu from './RotateMenu.svelte';
	import ToolToggle from './ToolToggle.svelte';
	import InsertToggle from './InsertToggle.svelte';
	import PanelToggle from './PanelToggle.svelte';
	import type { PdfLayout, PdfZoom, ReaderTheme } from './types.js';

	let page = $state(12);
	let pageCount = $state(240);
	let fraction = $state(.1005);
	let zoom = $state<PdfZoom>('auto');
	let scale = $state(1.25);
	let layout = $state<PdfLayout>('single-continuous');
	let coverAlone = $state(false);
	let theme = $state<ReaderTheme>('light');
	let ocrEnabled = $state(true);
	let tool = $state<'select' | 'hand'>('select');
	let active = $state(false);
	let panelOpen = $state(false);
	let count = $state(3);
	let disabled = $state(false);
	let showOcr = $state(true);

	function log(action: string, value: string | number | boolean) { window.log.push({ action, value }); }

	onMount(() => {
		const update = (event: Event) => {
			const detail = (event as CustomEvent<{
				page?: number; pageCount?: number; fraction?: number; count?: number;
				disabled?: boolean; showOcr?: boolean;
			}>).detail;
			if (detail.page !== undefined) page = detail.page;
			if (detail.pageCount !== undefined) pageCount = detail.pageCount;
			if (detail.fraction !== undefined) fraction = detail.fraction;
			if (detail.count !== undefined) count = detail.count;
			if (detail.disabled !== undefined) disabled = detail.disabled;
			if (detail.showOcr !== undefined) showOcr = detail.showOcr;
		};
		window.addEventListener('pv4-fixture-update', update);
		return () => window.removeEventListener('pv4-fixture-update', update);
	});
</script>

<ReaderToolbar>
	{#snippet left()}
		<PageCounter {page} {pageCount} {disabled} onjump={(next) => { page = next; log('jump', next); }} />
		<ProgressLabel {fraction} />
	{/snippet}
	{#snippet centre()}<span>A book-like PDF reader with a very long title that truncates</span>{/snippet}
	{#snippet overflow()}
		<ZoomMenu {zoom} {scale} onzoom={(next) => { zoom = next; log('zoom', next); }} onstep={(step) => { scale += step * .1; zoom = scale; log('step', step); }} />
		<LayoutMenu {layout} {coverAlone} {theme} {ocrEnabled}
			onlayout={(next) => { layout = next; log('layout', next); }}
			oncoveralone={(next) => { coverAlone = next; log('cover', next); }}
			ontheme={(next) => { theme = next; log('theme', next); }}
			onocr={showOcr ? (next) => { ocrEnabled = next; log('ocr', next); } : undefined} />
		<RotateMenu onrotate={(delta) => log('rotate', delta)} />
	{/snippet}
	{#snippet right()}
		<ToolToggle {tool} ontoggle={() => { tool = tool === 'select' ? 'hand' : 'select'; active = false; log('tool', tool); }} />
		<InsertToggle {active} {disabled} ontoggle={() => { active = !active; log('insert', active); }} />
		<PanelToggle open={panelOpen} {count} ontoggle={() => { panelOpen = !panelOpen; log('panel', panelOpen); }} />
		<span class="divider" aria-hidden="true"></span>
		<button type="button" class="pv4-button" aria-label={m['reader.close']()} title={m['reader.close']()} onclick={() => log('close', true)}><Icon name="x" /></button>
	{/snippet}
	{#snippet status()}<span class="status" role="status" aria-label="Online"></span>{/snippet}
</ReaderToolbar>
<main>
	<div class="paper">PDF page fixture</div>
	<button type="button" class="after">After toolbar</button>
</main>

<style>
	:global(body) { margin: 0; font-family: system-ui, sans-serif; background: #e2e8f0; }
	:global(:root[data-theme='dark'] body) { background: #18181b; color: #f5f6f7; }
	.divider { width: 1px; height: 20px; margin: 0 2px; background: #94a3b8; }
	.status { width: 5px; height: 5px; border-radius: 50%; background: #10b981; }
	main { padding: 8px; }
	.paper { max-width: 700px; height: 700px; margin: auto; padding: 24px; box-sizing: border-box; background: white; color: #475569; box-shadow: 0 2px 6px #0002; }
	.after { margin-top: 12px; }
</style>
