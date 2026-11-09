<script lang="ts">
	import Icon from '#lib/bookview/Icon.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import './toolbar.css';
	let { tool, ontoggle }: { tool: 'select' | 'hand'; ontoggle: () => void } = $props();
	const label = $derived(tool === 'hand' ? m['pv4.hand']() : m['pv4.select']());
</script>

<button type="button" class="pv4-button" aria-label={label} title={`${label} (${tool === 'hand' ? 'H' : 'V'})`} aria-pressed={tool === 'hand'} onclick={ontoggle}>
	<Icon name={tool === 'hand' ? 'hand' : 'text-cursor'} />
</button>
