<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import UploadDialog from './UploadDialog.svelte';
	import { controlIconClass, iconControlClass } from '#lib/catalog/filter-styles.js';

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
	class="{iconControlClass} transition-colors"
	aria-haspopup="dialog"
	aria-label={m['bh3.button']()}
	title={m['bh3.button']()}
	onclick={() => (open = true)}
>
	<svg aria-hidden="true" viewBox="0 0 20 20" class={controlIconClass} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M10 13V3m0 0L6 7m4-4l4 4M3 13v2a2 2 0 002 2h10a2 2 0 002-2v-2" />
	</svg>
</button>
<UploadDialog {open} onclose={() => void close()} />
