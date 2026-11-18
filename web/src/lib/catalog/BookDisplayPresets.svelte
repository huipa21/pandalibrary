<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		applyBookDisplayPreset,
		BOOK_DISPLAY_PRESETS,
		bookDisplay,
		nextBookDisplayPresetId,
		type BookDisplayPresetId
	} from './book-display.svelte.js';

	function presetLabel(id: BookDisplayPresetId): string {
		switch (id) {
			case 'small': return m['organize.cover_size_small']();
			case 'medium': return m['organize.cover_size_medium']();
			case 'big': return m['organize.cover_size_big']();
			case 'large': return m['organize.cover_size_large']();
		}
	}

	const activePreset = $derived(
		BOOK_DISPLAY_PRESETS.find(
			(preset) => preset.size === bookDisplay.size && preset.spacing === bookDisplay.spacing
		)
	);
	const currentLabel = $derived(
		activePreset
			? presetLabel(activePreset.id)
			: `${bookDisplay.size} × ${bookDisplay.spacing}px`
	);

	function cyclePreset() {
		applyBookDisplayPreset(nextBookDisplayPresetId(bookDisplay.size));
	}
</script>

<button
	type="button"
	class="control-button control-square"
	aria-label={m['organize.cover_size']()}
	title={`${m['organize.cover_size']()} · ${currentLabel}`}
	data-book-display-presets
	data-cover-preset={activePreset?.id ?? 'custom'}
	onclick={cyclePreset}
>
	<span
		aria-hidden="true"
		class="block rounded-[2px] border border-current"
		style={`width: ${bookDisplay.size / 12}px; height: ${bookDisplay.size / 8}px`}
	></span>
</button>
