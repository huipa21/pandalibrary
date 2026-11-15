<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import LibraryForm from '#lib/admin/LibraryForm.svelte';
	import { createLibrary } from '#lib/admin/api.js';
	import { adminErrorKey } from '#lib/admin/form.js';
	import { translate } from '#lib/paging/translate.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();
	let dialogElement = $state<HTMLDialogElement | null>(null);
	let submitting = $state(false);

	$effect(() => {
		if (!open || !dialogElement) return;
		const dialog = dialogElement;
		const originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.showModal();
		dialog.querySelector<HTMLInputElement>('#new-library-name')?.focus();
		return () => {
			if (dialog.open) dialog.close();
			if (originalFocus?.isConnected) originalFocus.focus();
		};
	});

	async function save(name: string, slug: string, icon: string): Promise<string | null> {
		submitting = true;
		try {
			const library = await createLibrary(name, slug, icon);
			onclose();
			window.dispatchEvent(new CustomEvent('pandalibrary-libraries-changed', { detail: { createdLibrary: library } }));
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'save_library'));
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
		aria-label={m['ux1.library.new']()} oncancel={cancel} {onkeydown}>
		<h2 class="mb-4 text-lg font-semibold">{m['ux1.library.new']()}</h2>
		<LibraryForm idPrefix="new-library" suggestSlugFromName stacked submitLabel={m['admin.libraries.create']()} busyLabel={m['admin.libraries.creating']()}
			onsave={save} oncancel={() => { if (!submitting) onclose(); }} />
	</dialog>
{/if}

<style>
	dialog::backdrop { background: rgb(15 23 42 / 0.6); }
</style>
