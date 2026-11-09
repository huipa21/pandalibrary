<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import ToolbarMenu from './ToolbarMenu.svelte';
	import MenuItem from './MenuItem.svelte';
	import type { PdfLayout, ReaderTheme } from './types.js';
	let { layout, coverAlone, theme, ocrEnabled = false, onlayout, oncoveralone, ontheme, onocr }: {
		layout: PdfLayout; coverAlone: boolean; theme: ReaderTheme; ocrEnabled?: boolean;
		onlayout: (layout: PdfLayout) => void; oncoveralone: (alone: boolean) => void;
		ontheme: (theme: ReaderTheme) => void; onocr?: (enabled: boolean) => void;
	} = $props();
</script>

<ToolbarMenu label={m['pv4.display']()} icon="layout-single">
	<MenuItem label={m['pv4.single']()} icon="layout-single" role="menuitemradio" checked={layout === 'single'} onchoose={() => onlayout('single')} />
	<MenuItem label={m['pv4.single_continuous']()} icon="layout-continuous" role="menuitemradio" checked={layout === 'single-continuous'} onchoose={() => onlayout('single-continuous')} />
	<MenuItem label={m['pv4.split']()} icon="layout-split" role="menuitemradio" checked={layout === 'split'} onchoose={() => onlayout('split')} />
	<MenuItem label={m['pv4.split_continuous']()} icon="layout-split-continuous" role="menuitemradio" checked={layout === 'split-continuous'} onchoose={() => onlayout('split-continuous')} />
	<MenuItem label={m['pv4.cover_alone']()} role="menuitemcheckbox" checked={coverAlone} disabled={!layout.startsWith('split')} onchoose={() => oncoveralone(!coverAlone)} />
	<div class="pv4-separator" role="separator"></div>
	<div role="group" aria-label={m['reader.settings.theme']()}>
		<MenuItem label={m['reader.settings.light']()} role="menuitemradio" checked={theme === 'light'} onchoose={() => ontheme('light')} />
		<MenuItem label={m['reader.settings.sepia']()} role="menuitemradio" checked={theme === 'sepia'} onchoose={() => ontheme('sepia')} />
		<MenuItem label={m['reader.settings.dark']()} role="menuitemradio" checked={theme === 'dark'} onchoose={() => ontheme('dark')} />
	</div>
	{#if onocr}
		<div class="pv4-separator" role="separator"></div>
		<MenuItem label={m['pv4.ocr']()} role="menuitemcheckbox" checked={ocrEnabled} onchoose={() => onocr?.(!ocrEnabled)} />
	{/if}
</ToolbarMenu>
