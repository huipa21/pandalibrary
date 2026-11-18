<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';

	let { mode, ontoggle }: { mode: boolean; ontoggle: () => void } = $props();
	const label = $derived(mode ? m['reader.mode.exit']() : m['reader.mode.enter']());
</script>

<button
	type="button"
	class="pv4-button"
	data-testid="reader-mode-toggle"
	aria-pressed={mode}
	aria-label={label}
	title={label}
	onclick={ontoggle}
>
	<Icon name={mode ? 'minimize' : 'maximize'} />
</button>
