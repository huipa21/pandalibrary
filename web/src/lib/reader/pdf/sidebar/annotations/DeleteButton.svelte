<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';

	let { excerpt, busy, ondelete, icon = true, onkeydown }: {
		excerpt: string;
		busy: boolean;
		ondelete: () => void | Promise<void>;
		icon?: boolean;
		onkeydown?: (event: KeyboardEvent) => void;
	} = $props();
	let confirming = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function reset() {
		clearTimeout(timer);
		confirming = false;
	}

	function click() {
		if (confirming) {
			reset();
			void ondelete();
		} else {
			confirming = true;
			timer = setTimeout(reset, 3000);
		}
	}
	onDestroy(() => clearTimeout(timer));
</script>

<button
	type="button"
	class="rp7-delete-button"
	class:rp7-delete-confirm={confirming}
	class:rp7-delete-text={!icon}
	data-rp7-delete
	aria-label={confirming ? m['rp7.confirm_delete_label']({ excerpt }) : m['rp7.delete']({ excerpt })}
	title={confirming ? m['rp7.confirm_delete_label']({ excerpt }) : m['rp7.delete']({ excerpt })}
	disabled={busy}
	onclick={click}
	onblur={reset}
	{onkeydown}
>
	{#if confirming}
		{m['rp7.confirm_delete']()}
	{:else if icon}
		<Icon name="trash" class="size-4" />
	{:else}
		{m['reader.annotations.delete']()}
	{/if}
</button>
