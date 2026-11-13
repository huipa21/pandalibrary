<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { createShelf } from './api.js';
	import { shelfErrorKey, type ShelfFormValue } from './form.js';
	import { translate } from '#lib/paging/translate.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import ShelfForm from './ShelfForm.svelte';

	let { open, allowShared, onclose }: { open: boolean; allowShared: boolean; onclose: () => void } = $props();
	let dialogElement = $state<HTMLDialogElement | null>(null);
	let submitting = $state(false);

	$effect(() => {
		if (!open || !dialogElement) return;
		const dialog = dialogElement;
		const originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.showModal();
		dialog.querySelector<HTMLInputElement>('#create-shelf-name')?.focus();
		return () => {
			if (dialog.open) dialog.close();
			if (originalFocus?.isConnected) originalFocus.focus();
		};
	});

	async function save(value: ShelfFormValue): Promise<string | null> {
		submitting = true;
		try {
			const shelf = await createShelf(value);
			onclose();
			window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed', { detail: { createdShelf: shelf } }));
			return null;
		} catch (cause) {
			return translate(shelfErrorKey(cause, 'save'));
		} finally {
			submitting = false;
		}
	}

	function cancel(event: Event) {
		event.preventDefault();
		if (!submitting) onclose();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const target = nextTrappedFocus(focusableWithin(dialogElement), document.activeElement, event.shiftKey);
		if (target) { event.preventDefault(); target.focus(); }
	}
</script>

{#if open}
	<dialog bind:this={dialogElement} class="fixed inset-0 m-auto max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-6 text-slate-950 shadow-lg"
		aria-label={m['ux3.shelves.create_dialog_title']()} oncancel={cancel} {onkeydown}>
		<h2 class="mb-4 text-lg font-semibold">{m['ux3.shelves.create_dialog_title']()}</h2>
		<ShelfForm idPrefix="create-shelf" {allowShared} compactKindLabels nameLabel={m['ux3.shelves.name_label']()} submitLabel={m['ux3.shelves.create_submit']()} busyLabel={m['ux3.shelves.creating']()}
			onsave={save} oncancel={() => { if (!submitting) onclose(); }} />
	</dialog>
{/if}

<style>
	dialog::backdrop { background: rgb(15 23 42 / 0.6); }
</style>
