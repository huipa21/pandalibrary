<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';

	let { mode, ontoggle, compact = false }: { mode: boolean; ontoggle: () => void; compact?: boolean } = $props();
	const label = $derived(mode ? m['reader.mode.exit']() : m['reader.mode.enter']());
</script>

<button
	type="button"
	class={compact ? 'pv4-item' : 'pv4-button'}
	role={compact ? 'menuitem' : undefined}
	data-testid="reader-mode-toggle"
	aria-pressed={mode}
	aria-label={label}
	title={label}
	onclick={ontoggle}
>
	<Icon name={mode ? 'minimize' : 'maximize'} />
	{#if compact}<span class="pv4-item-label">{label}</span>{/if}
</button>
