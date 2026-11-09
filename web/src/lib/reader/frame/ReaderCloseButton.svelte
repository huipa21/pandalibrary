<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';

	let { closing, onclose }: { closing: boolean; onclose: () => void | Promise<void> } = $props();
</script>

<button
	type="button"
	class="grid size-9 shrink-0 place-items-center rounded-full border-0 hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 disabled:opacity-60"
	aria-label={m['reader.close']()}
	title={m['reader.close']()}
	aria-busy={closing}
	disabled={closing}
	onclick={onclose}
>
	{#if closing}
		<span class="size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" aria-hidden="true"></span>
	{:else}
		<Icon name="x" />
	{/if}
</button>
