<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import UserForm from './UserForm.svelte';
	import type { UserFormDraft } from './form.js';
	import type { User } from './types.js';

	let { open, mode, user, onclose, onsave }: {
		open: boolean;
		mode: 'create' | 'edit';
		user?: User;
		onclose: () => void;
		onsave: (input: UserFormDraft) => Promise<string | null>;
	} = $props();

	let dialogElement = $state<HTMLDialogElement | null>(null);
	let submitting = $state(false);

	const titleID = $derived(mode === 'create' ? 'create-user-heading' : 'edit-user-heading');
	const title = $derived(mode === 'create' ? m['admin.users.form.create_title']() : m['admin.users.form.edit_title']());

	$effect(() => {
		if (!open || !dialogElement) return;
		const dialog = dialogElement;
		const originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.showModal();
		const focusID = mode === 'create' ? '#field-username' : '#field-display_name';
		dialog.querySelector<HTMLInputElement>(focusID)?.focus();
		return () => {
			if (dialog.open) dialog.close();
			if (originalFocus?.isConnected) originalFocus.focus();
		};
	});

	async function save(input: UserFormDraft): Promise<string | null> {
		submitting = true;
		try {
			const error = await onsave(input);
			if (!error) onclose();
			return error;
		} finally {
			submitting = false;
		}
	}

	function close() {
		if (!submitting) onclose();
	}

	function cancel(event: Event) {
		event.preventDefault();
		close();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const target = nextTrappedFocus(focusableWithin(dialogElement), document.activeElement, event.shiftKey);
		if (target) { event.preventDefault(); target.focus(); }
	}
</script>

{#if open}
	<dialog bind:this={dialogElement} class="fixed inset-0 m-auto max-h-[90vh] w-[min(94vw,36rem)] overflow-y-auto rounded-lg bg-white p-6 text-slate-950 shadow-lg"
		aria-labelledby={titleID} aria-busy={submitting} oncancel={cancel} {onkeydown}>
		<h2 id={titleID} class="mb-4 text-lg font-semibold">{title}</h2>
		{#key `${mode}-${user?.id ?? 'new'}`}
			<UserForm {mode} {user} onsubmit={save} oncancel={close} />
		{/key}
	</dialog>
{/if}

<style>
	dialog::backdrop { background: rgb(15 23 42 / 0.6); }
</style>
