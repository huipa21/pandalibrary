<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { isMarkColor, markInk, MARK_PRESETS, resolveMarkColor, type MarkColor } from '../../annotations.js';
	import { markColors } from './mark-colors.svelte.js';

	let { value, label, onpick, autofocus = false, disabled = false }: {
		value: MarkColor | null;
		label: string;
		onpick: (color: MarkColor) => void;
		autofocus?: boolean;
		disabled?: boolean;
	} = $props();

	let group = $state<HTMLDivElement>();
	let picker = $state<HTMLInputElement>();
	let focused = $state<number | null>(null);
	const customIndex = MARK_PRESETS.length;
	const activeIndex = $derived.by(() => {
		if (!value || !isMarkColor(value)) return -1;
		const hex = resolveMarkColor(value);
		const preset = MARK_PRESETS.findIndex((entry) => resolveMarkColor(entry.value) === hex);
		return preset < 0 ? customIndex : preset;
	});
	const tabStop = $derived(focused ?? (activeIndex < 0 ? 0 : activeIndex));
	const customColor = $derived(activeIndex === customIndex && value ? resolveMarkColor(value) : markColors.custom);

	$effect(() => {
		if (autofocus) group?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
	});

	function onkeydown(event: KeyboardEvent) {
		let index = tabStop;
		if (event.key === 'ArrowRight') index = (index + 1) % (customIndex + 1);
		else if (event.key === 'ArrowLeft') index = (index + customIndex) % (customIndex + 1);
		else if (event.key === 'ArrowDown') index = index < 8 ? index + 8 : index === 8 ? customIndex : index < 16 ? index - 8 : 0;
		else if (event.key === 'ArrowUp') index = index === 0 ? customIndex : index < 8 ? index + 8 : index < 16 ? index - 8 : 8;
		else if (event.key === 'Home') index = 0;
		else if (event.key === 'End') index = customIndex;
		else return;
		event.preventDefault();
		event.stopPropagation();
		focused = index;
		group?.querySelector<HTMLButtonElement>(`[data-color-index="${index}"]`)?.focus();
	}

	function checkInk(color: string): string {
		return markInk(color, 'dark') === '#e5e7eb' ? '#e5e7eb' : '#111827';
	}

	function pickCustom(event: Event) {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement)) return;
		markColors.setCustom(input.value);
		onpick(input.value);
	}
</script>

<div bind:this={group} class="pv8-palette" role="radiogroup" aria-label={label} tabindex="-1" {onkeydown}>
	{#each MARK_PRESETS as preset, index (preset.value)}
		<button
			type="button"
			role="radio"
			class="pv8-swatch"
			data-color={preset.value}
			data-color-index={index}
			aria-checked={activeIndex === index}
			aria-label={m[preset.name]()}
			title={m[preset.name]()}
			tabindex={tabStop === index ? 0 : -1}
			style:--pv-swatch={resolveMarkColor(preset.value)}
			style:color={checkInk(resolveMarkColor(preset.value))}
			{disabled}
			onmousedown={(event) => event.preventDefault()}
			onfocus={() => { focused = index; }}
			onclick={() => onpick(preset.value)}
		>
			{#if activeIndex === index}<Icon name="check" class="size-4" />{/if}
		</button>
	{/each}
	<button
		type="button"
		role="radio"
		class="pv8-swatch pv8-custom"
		data-color-index={customIndex}
		aria-checked={activeIndex === customIndex}
		aria-label={m['rp3.custom']()}
		title={m['rp3.custom']()}
		tabindex={tabStop === customIndex ? 0 : -1}
		{disabled}
		onmousedown={(event) => event.preventDefault()}
		onfocus={() => { focused = customIndex; }}
		onclick={() => picker?.click()}
	>
		<span class="pv8-custom-inner" style:background={customColor ?? 'var(--pv-palette-bg, white)'} style:color={checkInk(customColor ?? '#ffffff')}>
			{#if activeIndex === customIndex}<Icon name="check" class="size-4" />{/if}
		</span>
	</button>
	<input
		bind:this={picker}
		class="pv8-native-color"
		type="color"
		value={customColor ?? '#000000'}
		tabindex="-1"
		aria-hidden="true"
		{disabled}
		onchange={pickCustom}
	/>
</div>
