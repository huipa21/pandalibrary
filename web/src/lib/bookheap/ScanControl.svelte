<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { iconButton } from '#lib/admin/ui.js';
	import type { ScanController } from './scan.svelte.js';

	let { controller }: { controller: ScanController } = $props();

	const label = $derived(controller.busy ? m['bh4.scan.running']() : m['bh4.scan.button']());
</script>

<button
	type="button"
	class={iconButton}
	aria-label={label}
	title={label}
	aria-disabled={controller.busy ? 'true' : undefined}
	onclick={() => {
		if (!controller.busy) void controller.start();
	}}
>
	{#if controller.busy}
		<svg aria-hidden="true" viewBox="0 0 20 20" class="size-5 animate-spin" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M10 3a7 7 0 1 0 7 7" stroke-linecap="round" />
		</svg>
	{:else}
		<svg aria-hidden="true" viewBox="0 0 20 20" class="size-5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
			<path d="M4 10a6 6 0 0 1 10.2-4.2L16 7.5M16 3.5v4h-4M16 10a6 6 0 0 1-10.2 4.2L4 12.5M4 16.5v-4h4" />
		</svg>
	{/if}
</button>
