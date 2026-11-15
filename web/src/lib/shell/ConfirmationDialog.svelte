<script lang="ts">
	import { onDestroy } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import * as m from '#lib/paraglide/messages.js';
	import HeapDialog from '#lib/bookheap/HeapDialog.svelte';
	import { primaryButton, secondaryButton } from '#lib/admin/ui.js';
	import { confirmation, cancelConfirmation } from './confirmation.js';

	afterNavigate(cancelConfirmation);
	onDestroy(cancelConfirmation);
</script>

<HeapDialog open={$confirmation !== null} id="app-confirmation" title={m['common.confirm_title']()}
	onclose={cancelConfirmation} initialFocus="#app-confirmation-cancel">
	<p class="mt-4 whitespace-pre-wrap" id="app-confirmation-message">{$confirmation?.message}</p>
	<div class="mt-6 flex justify-end gap-3">
		<button id="app-confirmation-cancel" type="button" class={secondaryButton} onclick={cancelConfirmation}>{m['admin.cancel']()}</button>
		<button type="button" class={primaryButton} onclick={() => $confirmation?.resolve(true)}>{m['common.confirm']()}</button>
	</div>
</HeapDialog>
