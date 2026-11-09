<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '#lib/bookview/Icon.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import ToolbarMenu from './ToolbarMenu.svelte';
	import MenuItem from './MenuItem.svelte';
	import type { PdfZoom } from './types.js';
	let { zoom, scale, onzoom, onstep }: {
		zoom: PdfZoom; scale: number; onzoom: (zoom: PdfZoom) => void; onstep: (step: -1 | 1) => void;
	} = $props();
	let modifier = $state('Ctrl');
	onMount(() => { if (/Mac|iPhone|iPad/.test(navigator.platform)) modifier = '⌘'; });
</script>

<ToolbarMenu label={m['pv4.zoom']()} text={`${Math.round(scale * 100)}%`}>
	<MenuItem label={m['pv4.zoom_auto']()} icon="zoom-auto" role="menuitemradio" checked={zoom === 'auto'} onchoose={() => onzoom('auto')} />
	<MenuItem label={m['pv4.actual_size']()} icon="actual-size" role="menuitemradio" checked={zoom === 'page-actual'} onchoose={() => onzoom('page-actual')} />
	<MenuItem label={m['pv4.fit_page']()} icon="fit-page" role="menuitemradio" checked={zoom === 'page-fit'} onchoose={() => onzoom('page-fit')} />
	<MenuItem label={m['pv4.page_width']()} icon="fit-width" role="menuitemradio" checked={zoom === 'page-width'} onchoose={() => onzoom('page-width')} />
	<div class="pv4-separator" role="separator"></div>
	<div class="pv4-steps" role="group" aria-label={m['pv4.zoom']()}>
		<button type="button" role="menuitem" class="pv4-button" data-pv4-keep-open aria-label={m['pv4.zoom_out']()} title={m['pv4.zoom_out']()} onclick={() => onstep(-1)}><Icon name="zoom-out" /></button>
		<button type="button" role="menuitem" class="pv4-button" data-pv4-keep-open aria-label={m['pv4.zoom_in']()} title={m['pv4.zoom_in']()} onclick={() => onstep(1)}><Icon name="zoom-in" /></button>
	</div>
	<p class="pv4-hint">{m['pv4.zoom_hint']({ modifier })}</p>
</ToolbarMenu>
