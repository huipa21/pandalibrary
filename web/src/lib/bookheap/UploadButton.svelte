<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import UploadDialog from './UploadDialog.svelte';

	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);

	async function close() {
		open = false;
		await tick();
		trigger?.focus();
	}
</script>

<button
	bind:this={trigger}
	type="button"
	class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-white/15 px-2 text-sm text-zinc-200 transition-colors hover:border-white/30 hover:bg-shell-700 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-shell-accent sm:px-2.5"
	aria-haspopup="dialog"
	onclick={() => (open = true)}
>
	<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M10 13V3m0 0L6 7m4-4l4 4M3 13v2a2 2 0 002 2h10a2 2 0 002-2v-2" />
	</svg>
	<span class="sr-only sm:not-sr-only">{m['bh3.button']()}</span>
</button>
<UploadDialog {open} onclose={() => void close()} />
