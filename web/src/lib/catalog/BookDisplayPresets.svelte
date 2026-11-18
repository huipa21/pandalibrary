<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		applyBookDisplayPreset,
		BOOK_DISPLAY_PRESETS,
		bookDisplay,
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
</script>

<div class="flex min-w-0 flex-wrap items-center gap-2" data-book-display-presets>
	<span class="text-xs font-medium text-slate-500">{m['organize.cover_size']()}</span>
	<div
		class="inline-flex items-center rounded-lg border border-slate-300 bg-white p-0.5 shadow-sm"
		role="group"
		aria-label={m['organize.cover_size']()}
	>
		{#each BOOK_DISPLAY_PRESETS as preset (preset.id)}
			{@const active = bookDisplay.size === preset.size && bookDisplay.spacing === preset.spacing}
			{@const label = presetLabel(preset.id)}
			<button
				type="button"
				class={`inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 ${active ? 'bg-emerald-50 text-emerald-800' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
				aria-label={label}
				title={label}
				aria-pressed={active}
				data-cover-preset={preset.id}
				onclick={() => applyBookDisplayPreset(preset.id)}
			>
				<span
					aria-hidden="true"
					class="block rounded-[2px] border border-current"
					style={`width: ${preset.size / 12}px; height: ${preset.size / 8}px`}
				></span>
			</button>
		{/each}
	</div>
</div>
