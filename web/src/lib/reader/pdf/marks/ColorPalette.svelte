<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { HIGHLIGHT_COLORS, HIGHLIGHT_HEX, type HighlightColor } from '../../annotations.js';

	let { value, label, onpick, autofocus = false }: {
		value: HighlightColor | null;
		label: string;
		onpick: (color: HighlightColor) => void;
		autofocus?: boolean;
	} = $props();

	let group = $state<HTMLDivElement>();
	let focused = $state<HighlightColor | null>(null);
	const tabStop = $derived(focused ?? value ?? HIGHLIGHT_COLORS[0]);

	const names: Record<HighlightColor, () => string> = {
		yellow: () => m['reader.annotations.yellow'](),
		green: () => m['reader.annotations.green'](),
		blue: () => m['reader.annotations.blue'](),
		pink: () => m['reader.annotations.pink'](),
		orange: () => m['reader.annotations.orange'](),
		purple: () => m['reader.annotations.purple']()
	};

	$effect(() => {
		if (autofocus) group?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
	});

	function onkeydown(event: KeyboardEvent) {
		const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
		let index = HIGHLIGHT_COLORS.indexOf(tabStop);
		if (event.key in keys) index = (index + keys[event.key] + HIGHLIGHT_COLORS.length) % HIGHLIGHT_COLORS.length;
		else if (event.key === 'Home') index = 0;
		else if (event.key === 'End') index = HIGHLIGHT_COLORS.length - 1;
		else return;
		event.preventDefault();
		event.stopPropagation();
		focused = HIGHLIGHT_COLORS[index];
		group?.querySelector<HTMLButtonElement>(`[data-color="${focused}"]`)?.focus();
	}
</script>

<div bind:this={group} class="pv8-palette" role="radiogroup" aria-label={label} tabindex="-1" {onkeydown}>
	{#each HIGHLIGHT_COLORS as color (color)}
		<button
			type="button"
			role="radio"
			class="pv8-swatch"
			data-color={color}
			aria-checked={value === color}
			aria-label={names[color]()}
			title={names[color]()}
			tabindex={tabStop === color ? 0 : -1}
			style:--pv-swatch={HIGHLIGHT_HEX[color]}
			onmousedown={(event) => event.preventDefault()}
			onfocus={() => { focused = color; }}
			onclick={() => onpick(color)}
		>
			{#if value === color}<Icon name="check" class="size-4" />{/if}
		</button>
	{/each}
</div>
