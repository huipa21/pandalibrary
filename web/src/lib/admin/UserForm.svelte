<script lang="ts">
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { validateUserDraft, type UserFormDraft } from './form.js';
	import { inputClass, primaryButton, secondaryButton } from './ui.js';
	import type { User } from './types.js';

	interface Props {
		mode: 'create' | 'edit' | 'reset-password';
		user?: User;
		onsubmit: (input: UserFormDraft) => Promise<string | null>;
		oncancel: () => void;
	}

	const { mode, user, onsubmit, oncancel }: Props = $props();
	const initial = untrack(() => user);
	let username = $state(initial?.username ?? '');
	let displayName = $state(initial?.display_name ?? '');
	let password = $state('');
	let confirmation = $state('');
	let role = $state(initial?.role ?? 'user');
	let locale = $state(initial?.locale ?? 'en');
	let busy = $state(false);
	let errors = $state<Record<string, string>>({});

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		errors = {};
		const result = validateUserDraft({ username, displayName, password, role, locale }, mode !== 'edit');
		if (!result.ok) {
			errors = { [result.field]: translate(`admin.users.form.error.${result.error}`) };
			document.getElementById(`field-${result.field}`)?.focus();
			return;
		}
		if (mode === 'reset-password' && password !== confirmation) {
			errors.confirmation = m['ux8.password_mismatch']();
			document.getElementById('field-confirmation')?.focus();
			return;
		}
		busy = true;
		try {
			const error = await onsubmit(result.draft);
			if (error) errors.form = error;
			else {
				password = '';
				confirmation = '';
			}
		} catch (error) {
			console.error('Account form submission failed', error);
			errors.form = m['ux8.change_failed']();
		} finally {
			busy = false;
		}
	}
</script>

<form onsubmit={handleSubmit} novalidate class="space-y-4">
	{#if mode === 'reset-password' && user}
		<p class="text-sm text-slate-700">{user.username} ({user.display_name || '—'})</p>
	{:else}
		<div>
			<label for="field-username" class="block text-sm font-medium text-slate-700">{m['admin.users.username_label']()}</label>
			<input id="field-username" type="text" bind:value={username} class={inputClass} disabled={busy}
				autocomplete="username" aria-invalid={errors.username ? 'true' : 'false'}
				aria-describedby={errors.username ? 'error-username' : undefined} />
			{#if errors.username}<p id="error-username" class="mt-1 text-sm text-red-600">{errors.username}</p>{/if}
		</div>
		<div>
			<label for="field-display_name" class="block text-sm font-medium text-slate-700">{m['admin.users.display_name_label']()}</label>
			<input id="field-display_name" type="text" bind:value={displayName} class={inputClass} disabled={busy}
				aria-invalid={errors.display_name ? 'true' : 'false'}
				aria-describedby={errors.display_name ? 'error-display_name' : undefined} />
			{#if errors.display_name}<p id="error-display_name" class="mt-1 text-sm text-red-600">{errors.display_name}</p>{/if}
		</div>
		<div class="grid gap-3 sm:grid-cols-2">
			<div>
				<label for="field-role" class="block text-sm font-medium text-slate-700">{m['admin.users.role_label']()}</label>
				<select id="field-role" bind:value={role} class={inputClass} disabled={busy}>
					<option value="user">{m['admin.users.role_user']()}</option>
					<option value="admin">{m['admin.users.role_admin']()}</option>
				</select>
				{#if errors.role}<p class="mt-1 text-sm text-red-600">{errors.role}</p>{/if}
			</div>
			<div>
				<label for="field-locale" class="block text-sm font-medium text-slate-700">{m['admin.users.locale_label']()}</label>
				<select id="field-locale" bind:value={locale} class={inputClass} disabled={busy}>
					<option value="en">{m['admin.users.locale_en']()}</option>
					<option value="zh">{m['admin.users.locale_zh']()}</option>
				</select>
				{#if errors.locale}<p class="mt-1 text-sm text-red-600">{errors.locale}</p>{/if}
			</div>
		</div>
	{/if}
	{#if mode !== 'edit'}
		<div>
			<label for="field-password" class="block text-sm font-medium text-slate-700">
				{mode === 'reset-password' ? m['admin.users.form.password_new']() : m['admin.users.form.password_label']()}
			</label>
			<input id="field-password" type="password" bind:value={password} class={inputClass} disabled={busy}
				autocomplete="new-password" aria-invalid={errors.password ? 'true' : 'false'}
				aria-describedby={errors.password ? 'error-password' : 'hint-password'} />
			<p id="hint-password" class="mt-1 text-sm text-slate-600">{m['admin.users.form.password_help']()}</p>
			{#if errors.password}<p id="error-password" class="mt-1 text-sm text-red-600">{errors.password}</p>{/if}
		</div>
		{#if mode === 'reset-password'}
			<div>
				<label for="field-confirmation" class="block text-sm font-medium text-slate-700">{m['ux8.confirm_password']()}</label>
				<input id="field-confirmation" type="password" bind:value={confirmation} class={inputClass} disabled={busy}
					autocomplete="new-password" aria-invalid={errors.confirmation ? 'true' : 'false'}
					aria-describedby={errors.confirmation ? 'error-confirmation' : undefined} />
				{#if errors.confirmation}<p id="error-confirmation" class="mt-1 text-sm text-red-600">{errors.confirmation}</p>{/if}
				<p class="mt-1 text-sm text-slate-600">{m['ux8.reset_effect']()}</p>
			</div>
		{/if}
	{/if}
	{#if errors.form}<p class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{errors.form}</p>{/if}
	<div class="flex gap-2">
		<button type="submit" class={primaryButton} disabled={busy}>
			{mode === 'create' ? m['admin.users.form.submit_create']() : m['admin.users.form.submit_save']()}
		</button>
		<button type="button" class={secondaryButton} disabled={busy}
			onclick={() => { password = ''; confirmation = ''; oncancel(); }}>{m['admin.users.form.cancel']()}</button>
	</div>
</form>
