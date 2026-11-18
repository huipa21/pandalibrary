<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { createUser } from '#lib/admin/api.js';
	import { adminErrorKey, type UserFormDraft } from '#lib/admin/form.js';
	import { translate } from '#lib/paging/translate.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import { secondaryButton } from './ui.js';
	import UserForm from './UserForm.svelte';

	let { open, onclose, oncreated }: {
		open: boolean;
		onclose: () => void;
		oncreated: () => void | Promise<void>;
	} = $props();
	let dialogElement = $state<HTMLDialogElement | null>(null);
	let submitting = $state(false);
	let created = $state<{ username: string; password: string } | null>(null);
	let copied = $state(false);

	$effect(() => {
		if (!open || !dialogElement) return;
		const dialog = dialogElement;
		const originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.showModal();
		dialog.querySelector<HTMLInputElement>('#field-username')?.focus();
		return () => {
			if (dialog.open) dialog.close();
			if (originalFocus?.isConnected) originalFocus.focus();
		};
	});

	async function save(input: UserFormDraft): Promise<string | null> {
		submitting = true;
		try {
			await createUser({
				username: input.username,
				displayName: input.displayName,
				email: input.email ?? '',
				password: input.password,
				role: input.role
			});
			created = { username: input.username, password: input.password };
			await oncreated();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'create'));
		} finally {
			submitting = false;
		}
	}

	async function copyCredentials() {
		if (!created) return;
		try {
			await navigator.clipboard.writeText(`${created.username}\n${created.password}`);
			copied = true;
		} catch {
			copied = false;
		}
	}

	function close() {
		if (submitting) return;
		created = null;
		copied = false;
		onclose();
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
		aria-labelledby="create-user-heading" aria-busy={submitting} oncancel={cancel} {onkeydown}>
		<h2 id="create-user-heading" class="mb-4 text-lg font-semibold">{m['admin.users.form.create_title']()}</h2>
		{#if created}
			<div class="space-y-4">
				<p class="text-sm text-slate-700">{m['admin.users.form.create_success']()}</p>
				<div class="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-4">
					<p class="text-sm font-medium text-amber-950">{m['admin.users.form.temporary_password']()}</p>
					<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
						<dt class="text-slate-600">{m['admin.users.username_label']()}</dt>
						<dd class="font-mono">{created.username}</dd>
						<dt class="text-slate-600">{m['admin.users.form.password_label']()}</dt>
						<dd class="select-all break-all font-mono">{created.password}</dd>
					</dl>
					<p class="text-sm text-amber-950">{m['admin.users.form.password_generated_help']()}</p>
				</div>
				<div class="flex gap-2">
					<button type="button" class={secondaryButton} onclick={copyCredentials}>
						{copied ? m['admin.users.form.password_copied']() : m['admin.users.form.password_copy_both']()}
					</button>
					<button type="button" class={secondaryButton} onclick={close}>{m['admin.users.form.done']()}</button>
				</div>
			</div>
		{:else}
			<UserForm mode="create" onsubmit={save} oncancel={close} />
		{/if}
	</dialog>
{/if}

<style>
	dialog::backdrop { background: rgb(15 23 42 / 0.6); }
</style>
