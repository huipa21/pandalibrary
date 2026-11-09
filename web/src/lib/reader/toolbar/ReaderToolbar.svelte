<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import OverflowMenu from './OverflowMenu.svelte';
	import './toolbar.css';
	let { left, centre, right, overflow, status }: {
		left: Snippet; centre?: Snippet; right: Snippet; overflow?: Snippet; status?: Snippet;
	} = $props();
</script>

<div class="pv4-toolbar" role="toolbar" aria-label={m['pv4.toolbar']()}>
	<div class="pv4-left">{@render left()}{@render status?.()}</div>
	<div class="pv4-centre">{@render centre?.()}</div>
	<div class="pv4-right">
		{#if overflow}
			<div class="pv4-collapsible">{@render overflow()}</div>
			<div class="pv4-overflow"><OverflowMenu>{@render overflow()}</OverflowMenu></div>
		{/if}
		{@render right()}
	</div>
</div>

<style>
	.pv4-toolbar { position: relative; display: flex; flex: 1; align-items: center; gap: 4px; width: 100%; min-width: 0; height: 44px; min-height: 44px; box-sizing: border-box; padding: 0 4px; background: var(--shell-surface, white); color: var(--shell-text, #1f2937); font: 14px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; }
	.pv4-left, .pv4-right, .pv4-collapsible { display: flex; align-items: center; gap: 2px; flex: none; }
	.pv4-left { gap: 6px; }
	.pv4-centre { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center; color: #64748b; }
	.pv4-overflow { display: none; }
	:global(:root[data-theme='dark']) .pv4-toolbar { background: #1b1e21; color: #f5f6f7; }
	:global(:root[data-theme='dark']) .pv4-centre { color: #a0a7af; }
	@media (max-width: 1023px) { .pv4-centre { visibility: hidden; } }
	@media (max-width: 639px) { .pv4-collapsible { display: none; } .pv4-overflow { display: block; } }
</style>
