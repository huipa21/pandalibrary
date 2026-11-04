<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { validateUserDraft, userPatch, type UserFormDraft, type UserFieldError } from './form.js';
	import { inputClass, primaryButton, secondaryButton } from './ui.js';
	import type { User } from './types.js';

	interface Props {
		mode: 'create' | 'edit' | 'reset-password';
		user?: User;
		onsubmit: (input: Partial<UserFormDraft>) => Promise<string | null>;
		oncancel: () => void;
	}

	const { mode, user, onsubmit, oncancel }: Props = $props();

	let username = $state(user?.username || '');
	let displayName = $state(user?.display_name || '');
	let password = $state('');
	let role = $state(user?.role || 'user');
	let locale = $state(user?.locale || 'en');
	let busy = $state(false);
	let errors = $state<Record<string, UserFieldError | string>>({});

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;

		errors = {};
		busy = true;

		try {
			const requirePassword = mode === 'create' || mode === 'reset-password';
			const result = validateUserDraft({ username, displayName, password, role, locale }, requirePassword);

			if (!result.ok) {
				errors = { [result.field]: result.error };
				focusField(result.field);
				return;
			}

			let error: string | null = null;
			if (mode === 'edit' && user) {
				error = await onsubmit({ username: result.draft.username, displayName: result.draft.displayName, role: result.draft.role, locale: result.draft.locale });
			} else if (mode === 'reset-password') {
				error = await onsubmit({ password: result.draft.password });
			} else {
				error = await onsubmit(result.draft);
			}

			if (error) {
				errors.form = error;
			}
		} finally {
			busy = false;
		}
	}

	function focusField(field: string) {
		const el = document.getElementById(`field-${field}`);
		el?.focus();
	}

	function getFieldError(field: string): string {
		const error = errors[field];
		if (!error) return '';
		return m[`admin.users.form.error.${error}`] ? m[`admin.users.form.error.${error}`]() : error;
	}
</script>

<form {onsubmit} novalidate class="space-y-4">
	{#if mode === 'reset-password' && user}
		<div>
			<label for="field-user-info" class="block text-sm font-medium text-slate-700">{m['admin.users.username_label']()}</label>
			<div class="mt-1 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-slate-600">
				{user.username} ({user.display_name || '—'})
			</div>
		</div>
	{:else}
		<div>
			<label for="field-username" class="block text-sm font-medium text-slate-700">{m['admin.users.username_label']()}</label>
			<input
				type="text"
				id="field-username"
				bind:value={username}
				class={inputClass}
				aria-invalid={errors.username ? 'true' : 'false'}
				aria-describedby={errors.username ? 'error-username' : undefined}
				disabled={busy || (mode === 'edit' && user?.username === username)}
			/>
			{#if errors.username}
				<p id="error-username" class="mt-1 text-sm text-red-600">{getFieldError('username')}</p>
			{/if}
		</div>

		<div>
			<label for="field-display_name" class="block text-sm font-medium text-slate-700">{m['admin.users.display_name_label']()}</label>
			<input
				type="text"
				id="field-display_name"
				bind:value={displayName}
				class={inputClass}
				aria-invalid={errors.display_name ? 'true' : 'false'}
				aria-describedby={errors.display_name ? 'error-display_name' : undefined}
				disabled={busy}
			/>
			{#if errors.display_name}
				<p id="error-display_name" class="mt-1 text-sm text-red-600">{getFieldError('display_name')}</p>
			{/if}
		</div>

		<div class="grid gap-3 sm:grid-cols-2">
			<div>
				<label for="field-role" class="block text-sm font-medium text-slate-700">{m['admin.users.role_label']()}</label>
				<select id="field-role" bind:value={role} class={inputClass} disabled={busy}>
					<option value="user">{m['admin.users.role_user']()}</option>
					<option value="admin">{m['admin.users.role_admin']()}</option>
				</select>
				{#if errors.role}
					<p id="error-role" class="mt-1 text-sm text-red-600">{getFieldError('role')}</p>
				{/if}
			</div>

			<div>
				<label for="field-locale" class="block text-sm font-medium text-slate-700">{m['admin.users.locale_label']()}</label>
				<select id="field-locale" bind:value={locale} class={inputClass} disabled={busy}>
					<option value="en">{m['admin.users.locale_en']()}</option>
					<option value="zh">{m['admin.users.locale_zh']()}</option>
				</select>
				{#if errors.locale}
					<p id="error-locale" class="mt-1 text-sm text-red-600">{getFieldError('locale')}</p>
				{/if}
			</div>
		</div>
	{/if}

	<div>
		<label for="field-password" class="block text-sm font-medium text-slate-700">
			{mode === 'reset-password' ? m['admin.users.form.password_new']() : m['admin.users.form.password_label']()}
		</label>
		<input
			type="password"
			id="field-password"
			bind:value={password}
			class={inputClass}
			aria-invalid={errors.password ? 'true' : 'false'}
			aria-describedby={errors.password ? 'error-password' : 'hint-password'}
			disabled={busy}
			autocomplete={mode === 'create' ? 'new-password' : 'off'}
		/>
		<p id="hint-password" class="mt-1 text-sm text-slate-600">{m['admin.users.form.password_help']()}</p>
		{#if errors.password}
			<p id="error-password" class="mt-1 text-sm text-red-600">{getFieldError('password')}</p>
		{/if}
	</div>

	{#if errors.form}
		<p class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{errors.form}</p>
	{/if}

	<div class="flex gap-2">
		<button type="submit" class={primaryButton} disabled={busy}>
			{busy
				? mode === 'create'
					? m['admin.users.form.submit_create']()
					: m['admin.users.form.submit_save']()
				: mode === 'create'
					? m['admin.users.form.submit_create']()
					: m['admin.users.form.submit_save']()}
		</button>
		<button type="button" class={secondaryButton} onclick={oncancel} disabled={busy}>{m['admin.users.form.cancel']()}</button>
	</div>
</form>
