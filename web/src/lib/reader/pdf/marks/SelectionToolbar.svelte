<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { HIGHLIGHT_HEX, type HighlightColor, type HighlightStyle } from '../../annotations.js';
	import ColorPalette from './ColorPalette.svelte';
	import { roving } from './roving.js';
	import { floatAt } from './float-at.js';
	import type { RectLike } from './floating.js';
	import '../../toolbar/toolbar.css';

	let {
		anchor, bounds, hidden = false, color, disabled = false,
		oncopy, onmark, oncomment, onbookmark, onpick, onescape
	}: {
		anchor: RectLike;
		bounds: RectLike;
		hidden?: boolean;
		color: HighlightColor;
		disabled?: boolean;
		oncopy: () => void;
		onmark: (style: HighlightStyle) => void;
		oncomment: () => void;
		onbookmark: () => void;
		onpick: (color: HighlightColor) => void;
		onescape: () => void;
	} = $props();

	let paletteOpen = $state(false);
	let caret = $state<HTMLButtonElement>();

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		if (paletteOpen) {
			paletteOpen = false;
			caret?.focus();
		} else onescape();
	}

	// Buttons must not take the pointer focus away from the text, or the selection collapses.
	const keep = (event: MouseEvent) => event.preventDefault();
</script>

<div
	use:roving
	use:floatAt={{ anchor, bounds }}
	class="pv8-floating pv8-toolbar"
	class:pv8-hidden={hidden}
	role="toolbar"
	tabindex="-1"
	aria-label={m['pv8.selection_actions']()}
	data-testid="pv8-selection-toolbar"
	{onkeydown}
>
	<button type="button" class="pv4-button" data-roving aria-label={m['pv8.copy']()} title={m['pv8.copy']()} {disabled} onmousedown={keep} onclick={oncopy}>
		<Icon name="copy" />
	</button>
	<span class="pv8-split">
		<button type="button" class="pv4-button pv8-split-main" data-roving aria-label={m['pv8.highlight']()} title={m['pv8.highlight']()} {disabled} onmousedown={keep} onclick={() => onmark('highlight')}>
			<Icon name="highlighter" />
			<span class="pv8-colour-dot" style:background={HIGHLIGHT_HEX[color]} aria-hidden="true"></span>
		</button>
		<button
			bind:this={caret}
			type="button"
			class="pv4-button pv8-split-caret"
			data-roving
			aria-label={m['pv8.highlight_colors']()}
			title={m['pv8.highlight_colors']()}
			aria-haspopup="true"
			aria-expanded={paletteOpen}
			{disabled}
			onmousedown={keep}
			onclick={() => { paletteOpen = !paletteOpen; }}
		>
			<Icon name="chevron-down" class="size-3" />
		</button>
	</span>
	<button type="button" class="pv4-button" data-roving aria-label={m['pv8.underline']()} title={m['pv8.underline']()} {disabled} onmousedown={keep} onclick={() => onmark('underline')}>
		<Icon name="underline" />
	</button>
	<button type="button" class="pv4-button" data-roving aria-label={m['pv8.strikeout']()} title={m['pv8.strikeout']()} {disabled} onmousedown={keep} onclick={() => onmark('strikeout')}>
		<Icon name="strikethrough" />
	</button>
	<button type="button" class="pv4-button" data-roving aria-label={m['pv8.comment']()} title={m['pv8.comment']()} {disabled} onmousedown={keep} onclick={oncomment}>
		<Icon name="message" />
	</button>
	<button type="button" class="pv4-button" data-roving aria-label={m['pv8.bookmark']()} title={m['pv8.bookmark']()} {disabled} onmousedown={keep} onclick={onbookmark}>
		<Icon name="bookmark-plus" />
	</button>
	{#if paletteOpen}
		<div class="pv8-palette-popover">
			<ColorPalette
				value={color}
				label={m['pv8.highlight_colors']()}
				autofocus
				onpick={(picked) => { paletteOpen = false; onpick(picked); }}
			/>
		</div>
	{/if}
</div>
