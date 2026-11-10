<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { resolveMarkColor, type MarkColor, type HighlightStyle } from '../../annotations.js';
	import ColorPalette from './ColorPalette.svelte';
	import { roving } from './roving.js';
	import { floatAt } from './float-at.js';
	import type { RectLike } from './floating.js';
	import '../../toolbar/toolbar.css';

	let {
		anchor, bounds, hidden = false, highlightColor, lineColor, disabled = false,
		oncopy, onmark, oncomment, onbookmark, onpick, onescape
	}: {
		anchor: RectLike;
		bounds: RectLike;
		hidden?: boolean;
		highlightColor: MarkColor;
		lineColor: MarkColor;
		disabled?: boolean;
		oncopy: () => void;
		onmark: (style: HighlightStyle) => void;
		oncomment: () => void;
		onbookmark: () => void;
		onpick: (style: HighlightStyle, color: MarkColor) => void;
		onescape: () => void;
	} = $props();

	let paletteOpen = $state<'highlight' | 'line' | null>(null);
	let highlightCaret = $state<HTMLButtonElement>();
	let lineCaret = $state<HTMLButtonElement>();

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		if (paletteOpen) {
			const caret = paletteOpen === 'highlight' ? highlightCaret : lineCaret;
			paletteOpen = null;
			caret?.focus();
		} else onescape();
	}

	function fitPalette(node: HTMLElement, params: { anchor: RectLike; bounds: RectLike }) {
		const toolbar = node.parentElement;
		if (!toolbar) throw new Error('The mark palette has no toolbar.');
		let current = params;
		let frame = 0;
		const place = () => {
			const rect = toolbar.getBoundingClientRect();
			const top = Math.max(0, current.bounds.top) + 4;
			const bottom = Math.min(window.innerHeight, current.bounds.bottom) - 4;
			node.style.maxHeight = `${Math.max(0, bottom - top)}px`;
			const height = node.offsetHeight;
			const below = rect.bottom + 4;
			const above = rect.top - height - 4;
			const preferred = below + height <= bottom ? below : above >= top ? above : below;
			node.style.top = `${Math.max(top, Math.min(preferred, Math.max(top, bottom - height))) - rect.top}px`;
		};
		function schedule() {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(place);
		}
		const observer = new ResizeObserver(schedule);
		observer.observe(node);
		observer.observe(toolbar);
		window.addEventListener('resize', schedule);
		schedule();
		return {
			update(next: typeof params) { current = next; schedule(); },
			destroy() {
				cancelAnimationFrame(frame);
				observer.disconnect();
				window.removeEventListener('resize', schedule);
			}
		};
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
			<span class="pv8-colour-dot" style:background={resolveMarkColor(highlightColor)} aria-hidden="true"></span>
		</button>
		<button
			bind:this={highlightCaret}
			type="button"
			class="pv4-button pv8-split-caret"
			data-roving
			aria-label={m['pv8.highlight_colors']()}
			title={m['pv8.highlight_colors']()}
			aria-haspopup="true"
			aria-expanded={paletteOpen === 'highlight'}
			{disabled}
			onmousedown={keep}
			onclick={() => { paletteOpen = paletteOpen === 'highlight' ? null : 'highlight'; }}
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
	<button
		bind:this={lineCaret}
		type="button"
		class="pv4-button pv8-line-caret"
		data-roving
		aria-label={m['rp3.line_colors']()}
		title={m['rp3.line_colors']()}
		aria-haspopup="true"
		aria-expanded={paletteOpen === 'line'}
		{disabled}
		onmousedown={keep}
		onclick={() => { paletteOpen = paletteOpen === 'line' ? null : 'line'; }}
	>
		<Icon name="chevron-down" class="size-3" />
		<span class="pv8-colour-dot" style:background={resolveMarkColor(lineColor)} aria-hidden="true"></span>
	</button>
	<button type="button" class="pv4-button" data-roving aria-label={m['pv8.comment']()} title={m['pv8.comment']()} {disabled} onmousedown={keep} onclick={oncomment}>
		<Icon name="message" />
	</button>
	<button type="button" class="pv4-button" data-roving aria-label={m['pv8.bookmark']()} title={m['pv8.bookmark']()} {disabled} onmousedown={keep} onclick={onbookmark}>
		<Icon name="bookmark-plus" />
	</button>
	{#if paletteOpen}
		<div use:fitPalette={{ anchor, bounds }} class="pv8-palette-popover">
			<ColorPalette
				value={paletteOpen === 'highlight' ? highlightColor : lineColor}
				label={paletteOpen === 'highlight' ? m['pv8.highlight_colors']() : m['rp3.line_colors']()}
				autofocus
				{disabled}
				onpick={(picked) => {
					const style = paletteOpen === 'highlight' ? 'highlight' : 'underline';
					paletteOpen = null;
					onpick(style, picked);
					if (style === 'underline') lineCaret?.focus();
				}}
			/>
		</div>
	{/if}
</div>
