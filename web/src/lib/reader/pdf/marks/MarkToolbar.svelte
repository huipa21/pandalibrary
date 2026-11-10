<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { highlightColor, type MarkColor } from '../../annotations.js';
	import type { Highlight, HighlightStyle } from '../../types.js';
	import ColorPalette from './ColorPalette.svelte';
	import { roving } from './roving.js';
	import { floatAt } from './float-at.js';
	import type { RectLike } from './floating.js';
	import '../../toolbar/toolbar.css';

	let {
		mark, anchor, bounds, hasNote, disabled = false,
		oncolor, onstyle, oncomment, oncopy, ondelete, onclose
	}: {
		mark: Highlight;
		anchor: RectLike;
		bounds: RectLike;
		hasNote: boolean;
		disabled?: boolean;
		oncolor: (color: MarkColor) => void;
		onstyle: (style: HighlightStyle) => void;
		oncomment: () => void;
		oncopy: () => void;
		ondelete: () => void;
		onclose: () => void;
	} = $props();

	let element = $state<HTMLDivElement>();
	const styles: { value: HighlightStyle; icon: 'highlighter' | 'underline' | 'strikethrough'; label: () => string }[] = [
		{ value: 'highlight', icon: 'highlighter', label: () => m['pv8.highlight']() },
		{ value: 'underline', icon: 'underline', label: () => m['pv8.underline']() },
		{ value: 'strikeout', icon: 'strikethrough', label: () => m['pv8.strikeout']() }
	];
	const current = $derived(mark.style ?? 'highlight');

	onMount(() => element?.querySelector<HTMLElement>('.pv8-swatch[tabindex="0"]')?.focus({ preventScroll: true }));

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		onclose();
	}

	function onstylekey(event: KeyboardEvent) {
		const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
		if (!(event.key in keys)) return;
		event.preventDefault();
		event.stopPropagation();
		const index = styles.findIndex((style) => style.value === current);
		const next = styles[(index + keys[event.key] + styles.length) % styles.length];
		onstyle(next.value);
		element?.querySelector<HTMLElement>(`[data-mark-style="${next.value}"]`)?.focus();
	}
</script>

<div
	bind:this={element}
	use:floatAt={{ anchor, bounds }}
	class="pv8-floating pv8-mark-toolbar"
	role="dialog"
	tabindex="-1"
	aria-label={m['pv8.mark_actions']()}
	data-testid="pv8-mark-toolbar"
	data-annotation-id={mark.id}
	{onkeydown}
>
	<ColorPalette value={highlightColor(mark.color)} label={m['reader.annotations.color']()} {disabled} onpick={oncolor} />
	<div class="pv8-row">
		<div class="pv8-styles" role="radiogroup" tabindex="-1" aria-label={m['pv8.style']()} onkeydown={onstylekey}>
			{#each styles as style (style.value)}
				<button
					type="button"
					role="radio"
					class="pv4-button"
					data-mark-style={style.value}
					aria-checked={current === style.value}
					aria-label={style.label()}
					title={style.label()}
					tabindex={current === style.value ? 0 : -1}
					{disabled}
					onclick={() => onstyle(style.value)}
				>
					<Icon name={style.icon} />
				</button>
			{/each}
		</div>
		<span class="pv8-divider" aria-hidden="true"></span>
		<div class="pv8-actions" role="toolbar" tabindex="-1" aria-label={m['pv8.mark_actions']()} use:roving>
			<button type="button" class="pv4-button" data-roving aria-label={hasNote ? m['pv8.edit_comment']() : m['pv8.add_comment']()} title={hasNote ? m['pv8.edit_comment']() : m['pv8.add_comment']()} {disabled} onclick={oncomment}>
				<Icon name="message" />
			</button>
			<button type="button" class="pv4-button" data-roving aria-label={m['pv8.copy']()} title={m['pv8.copy']()} onclick={oncopy}>
				<Icon name="copy" />
			</button>
			<button type="button" class="pv4-button" data-roving aria-label={m['pv8.delete']()} title={m['pv8.delete']()} {disabled} onclick={ondelete}>
				<Icon name="trash" />
			</button>
		</div>
	</div>
</div>
