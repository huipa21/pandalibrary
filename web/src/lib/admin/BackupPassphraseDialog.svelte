<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import HeapDialog from '#lib/bookheap/HeapDialog.svelte';
	import { errorBox, inputClass, primaryButton, secondaryButton, warningBox } from '#lib/admin/ui.js';

	interface Props {
		open: boolean;
		mode: 'create' | 'restore';
		busy?: boolean;
		error?: string;
		/** False only for legacy .tar.gz archives that have no passphrase. */
		requiresPassphrase?: boolean;
		onclose: () => void;
		onsubmit: (passphrase: string) => void;
	}

	let { open, mode, busy = false, error = '', requiresPassphrase = true, onclose, onsubmit }: Props = $props();
	let passphrase = $state('');
	let confirmation = $state('');
	let localError = $state('');

	$effect(() => {
		if (!open) return;
		passphrase = '';
		confirmation = '';
		localError = '';
	});

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		localError = '';
		if (mode === 'create') {
			if ([...passphrase].length < 12) {
				localError = m['admin.backup.passphrase_too_short']();
				return;
			}
			if (passphrase !== confirmation) {
				localError = m['admin.backup.passphrase_mismatch']();
				return;
			}
		} else if (requiresPassphrase && passphrase === '') {
			localError = m['admin.backup.passphrase_required']();
			return;
		}
		onsubmit(passphrase);
	}
</script>

<HeapDialog
	{open}
	id="backup-passphrase"
	title={mode === 'create' ? m['admin.backup.create_title']() : m['admin.backup.restore_title']()}
	{busy}
	{onclose}
	initialFocus="#backup-passphrase-input"
>
	<form class="mt-4 space-y-4" onsubmit={submit}>
		<p class="text-sm text-slate-700">
			{mode === 'create' ? m['admin.backup.passphrase_help']() : m['admin.backup.restore_passphrase_help']()}
		</p>
		<p class={warningBox}>
			{mode === 'create' ? m['admin.backup.passphrase_warning']() : m['admin.backup.confirm_restore']()}
		</p>
		<label class="block space-y-1 text-sm font-medium" for="backup-passphrase-input">
			<span>{m['admin.backup.passphrase']()}</span>
			<input
				id="backup-passphrase-input"
				class={`${inputClass} w-full`}
				type="password"
				autocomplete={mode === 'create' ? 'new-password' : 'off'}
				spellcheck="false"
				bind:value={passphrase}
				required={mode === 'create' || requiresPassphrase}
			/>
		</label>
		{#if mode === 'create'}
			<label class="block space-y-1 text-sm font-medium" for="backup-passphrase-confirm">
				<span>{m['admin.backup.passphrase_confirm']()}</span>
				<input
					id="backup-passphrase-confirm"
					class={`${inputClass} w-full`}
					type="password"
					autocomplete="new-password"
					spellcheck="false"
					bind:value={confirmation}
					required
				/>
			</label>
		{/if}
		{#if localError || error}
			<p class={errorBox} role="alert">{localError || error}</p>
		{/if}
		<div class="flex flex-wrap justify-end gap-3">
			<button type="button" class={secondaryButton} disabled={busy} onclick={onclose}>{m['admin.cancel']()}</button>
			<button type="submit" class={primaryButton} disabled={busy}>
				{busy
					? m['admin.backup.submit_working']()
					: mode === 'create'
						? m['admin.backup.create_encrypted']()
						: m['admin.backup.restore_submit']()}
			</button>
		</div>
	</form>
</HeapDialog>
