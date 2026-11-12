<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import ToolbarMenu from './ToolbarMenu.svelte';
	import MenuItem from './MenuItem.svelte';
	import type { PdfLayout } from './types.js';
	let { layout, disabled = false, ocrEnabled = false, onlayout, onocr }: {
		layout: PdfLayout; disabled?: boolean; ocrEnabled?: boolean;
		onlayout: (layout: PdfLayout) => void; onocr?: (enabled: boolean) => void;
	} = $props();
</script>

<ToolbarMenu label={m['pv4.display']()} icon="layout-single" {disabled}>
	<MenuItem label={m['pv4.single']()} icon="layout-single" role="menuitemradio" checked={layout === 'single'} onchoose={() => onlayout('single')} />
	<MenuItem label={m['pv4.single_continuous']()} icon="layout-continuous" role="menuitemradio" checked={layout === 'single-continuous'} onchoose={() => onlayout('single-continuous')} />
	<MenuItem label={m['pv4.split']()} icon="layout-split" role="menuitemradio" checked={layout === 'split'} onchoose={() => onlayout('split')} />
	<MenuItem label={m['pv4.split_continuous']()} icon="layout-split-continuous" role="menuitemradio" checked={layout === 'split-continuous'} onchoose={() => onlayout('split-continuous')} />
	{#if onocr}
		<div class="pv4-separator" role="separator"></div>
		<MenuItem label={m['pv4.ocr']()} role="menuitemcheckbox" checked={ocrEnabled} onchoose={() => onocr?.(!ocrEnabled)} />
	{/if}
</ToolbarMenu>
