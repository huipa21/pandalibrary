<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import OverflowMenu from './OverflowMenu.svelte';
	import './toolbar.css';
	let { left, centre, right, overflow, status }: {
		left: Snippet; centre?: Snippet; right: Snippet; overflow?: Snippet; status?: Snippet;
	} = $props();
	let toolbarWidth = $state(0);
	let leftWidth = $state(0);
	let rightWidth = $state(0);
	// Reserve the wider side plus the toolbar's 4px padding and 4px grid gap on both sides.
	const titleSpace = $derived(toolbarWidth
		? `${Math.max(0, toolbarWidth - 2 * (Math.max(leftWidth, rightWidth) + 8))}px`
		: '100vw');
</script>

<div class="pv4-toolbar" role="toolbar" aria-label={m['pv4.toolbar']()} bind:clientWidth={toolbarWidth}>
	<div class="pv4-left" bind:clientWidth={leftWidth}>{@render left()}<div class="pv4-status">{@render status?.()}</div></div>
	<div class="pv4-centre" style:--pv4-title-space={titleSpace}>{@render centre?.()}</div>
	<div class="pv4-right" bind:clientWidth={rightWidth}>
		{#if overflow}
			<div class="pv4-collapsible">{@render overflow()}</div>
			<div class="pv4-overflow"><OverflowMenu>{@render overflow()}</OverflowMenu></div>
		{/if}
		{@render right()}
	</div>
</div>

<style>
	.pv4-toolbar { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); flex: 1; align-items: center; gap: 4px; width: 100%; min-width: 0; height: 44px; min-height: 44px; box-sizing: border-box; padding: 0 4px; background: var(--shell-surface, white); color: var(--shell-text, #1f2937); font: 14px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; }
	.pv4-left, .pv4-right, .pv4-collapsible { display: flex; align-items: center; gap: 2px; flex: none; }
	.pv4-left { justify-self: start; gap: .5em; white-space: nowrap; }
	.pv4-status { display: contents; white-space: normal; }
	.pv4-centre { min-width: 0; max-width: min(48vw, 640px, var(--pv4-title-space)); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center; color: #64748b; }
	.pv4-right { justify-self: end; }
	.pv4-overflow { display: none; }
	:global(:root[data-theme='dark']) .pv4-toolbar { background: #1b1e21; color: #f5f6f7; }
	:global(:root[data-theme='dark']) .pv4-centre { color: #a0a7af; }
	@media (max-width: 1023px) { .pv4-toolbar { grid-template-columns: auto 1fr; } .pv4-centre { display: none; } }
	@media (max-width: 639px) { .pv4-toolbar { gap: 0; padding: 0 2px; } .pv4-right { gap: 0; } .pv4-collapsible { display: none; } .pv4-overflow { display: block; } }
</style>
