<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { controlIconClass, iconControlClass } from '#lib/catalog/filter-styles.js';

	type View = 'grid' | 'list';
	let { view, onchange }: { view: View; onchange: (next: View) => void } = $props();

	const next = $derived<View>(view === 'grid' ? 'list' : 'grid');
	const label = $derived(next === 'grid' ? m['catalog.books.grid']() : m['catalog.books.list']());
</script>

<button type="button" class={iconControlClass} aria-label={label} title={label} data-view={view} onclick={() => onchange(next)}>
	<svg aria-hidden="true" viewBox="0 0 24 24" class={controlIconClass} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
		{#if next === 'grid'}
			<rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" /><rect x="13.5" y="13.5" width="7" height="7" rx="1" />
		{:else}
			<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
		{/if}
	</svg>
</button>
