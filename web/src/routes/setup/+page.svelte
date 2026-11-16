<script lang="ts">
	import { api } from '#lib/api/client.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { setLocale, type Locale } from '#lib/paraglide/runtime.js';
	import * as m from '#lib/paraglide/messages.js';
	import { withSessionLock } from '#lib/sync/engine.js';

	let token = $state('');
	let username = $state('');
	let displayName = $state('');
	let password = $state('');
	let confirmation = $state('');
	let showPassword = $state(false);
	let showConfirmation = $state(false);
	let locale = $state<Locale>('en');
	let error = $state('');
	let passwordError = $state('');
	let submitting = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		passwordError = '';
		if (password !== confirmation) {
			passwordError = m['auth.setup.password_mismatch']();
			document.getElementById('setup-confirm-password')?.focus();
			return;
		}
		submitting = true;
		try {
			await withSessionLock(() =>
				api.request<{ user: { locale: Locale } }>('/setup', {
					method: 'POST',
					body: { token, username, display_name: displayName, password, locale }
				})
			);
			await setLocale(locale, { reload: false });
			window.location.assign('/');
		} catch {
			error = m['auth.setup.failure']();
			submitting = false;
		}
	}
</script>

<section class="mx-auto max-w-md">
	<h1 class="text-3xl font-semibold tracking-tight">{m['auth.setup.title']()}</h1>
	<p class="mt-2 text-slate-600">{m['auth.setup.description']()}</p>
	<form class="mt-8 space-y-5" onsubmit={submit}>
		<label class="block space-y-2 text-sm font-medium" for="setup-token">
			<span>{m['auth.setup.token']()}</span>
			<input
				id="setup-token"
				class="w-full rounded-md border border-slate-300 px-3 py-2"
				autocomplete="one-time-code"
				required
				bind:value={token}
			/>
		</label>
		<label class="block space-y-2 text-sm font-medium" for="setup-username">
			<span>{m['auth.login.username']()}</span>
			<input
				id="setup-username"
				class="w-full rounded-md border border-slate-300 px-3 py-2"
				autocomplete="username"
				required
				bind:value={username}
			/>
		</label>
		<label class="block space-y-2 text-sm font-medium" for="display-name">
			<span>{m['auth.profile.display_name']()}</span>
			<input
				id="display-name"
				class="w-full rounded-md border border-slate-300 px-3 py-2"
				autocomplete="name"
				bind:value={displayName}
			/>
		</label>
		<div class="space-y-2">
			<label class="block text-sm font-medium" for="setup-password">{m['auth.login.password']()}</label>
			<div class="relative">
				<input
					id="setup-password"
					class="w-full rounded-md border border-slate-300 px-3 py-2 pr-11"
					type={showPassword ? 'text' : 'password'}
					autocomplete="new-password"
					minlength="8"
					maxlength="32"
					required
					aria-describedby="setup-password-help"
					bind:value={password}
				/>
				<button
					type="button"
					class="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-slate-500 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-slate-700"
					aria-label={showPassword ? m['auth.setup.hide_password']() : m['auth.setup.show_password']()}
					aria-pressed={showPassword}
					title={showPassword ? m['auth.setup.hide_password']() : m['auth.setup.show_password']()}
					onclick={() => (showPassword = !showPassword)}
				>
					<Icon name={showPassword ? 'eye-off' : 'eye'} class="size-5" />
				</button>
			</div>
			<p id="setup-password-help" class="text-sm font-normal text-slate-600">{m['auth.setup.password_help']()}</p>
		</div>
		<div class="space-y-2">
			<label class="block text-sm font-medium" for="setup-confirm-password">{m['auth.setup.confirm_password']()}</label>
			<div class="relative">
				<input
					id="setup-confirm-password"
					class="w-full rounded-md border border-slate-300 px-3 py-2 pr-11"
					type={showConfirmation ? 'text' : 'password'}
					autocomplete="new-password"
					minlength="8"
					maxlength="32"
					required
					aria-invalid={passwordError ? 'true' : 'false'}
					aria-describedby={passwordError ? 'setup-password-error' : undefined}
					bind:value={confirmation}
				/>
				<button
					type="button"
					class="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-slate-500 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-slate-700"
					aria-label={showConfirmation ? m['auth.setup.hide_confirmation_password']() : m['auth.setup.show_confirmation_password']()}
					aria-pressed={showConfirmation}
					title={showConfirmation ? m['auth.setup.hide_confirmation_password']() : m['auth.setup.show_confirmation_password']()}
					onclick={() => (showConfirmation = !showConfirmation)}
				>
					<Icon name={showConfirmation ? 'eye-off' : 'eye'} class="size-5" />
				</button>
			</div>
			{#if passwordError}<p id="setup-password-error" class="text-sm text-red-700" role="alert">{passwordError}</p>{/if}
		</div>
		<label class="block space-y-2 text-sm font-medium" for="locale">
			<span>{m['auth.profile.locale']()}</span>
			<select id="locale" class="w-full rounded-md border border-slate-300 px-3 py-2" bind:value={locale}>
				<option value="en">{m['common.language_english']()}</option>
				<option value="zh">{m['common.language_chinese']()}</option>
			</select>
		</label>
		{#if error}
			<p class="text-sm text-red-700" role="alert">{error}</p>
		{/if}
		<button
			class="button-primary w-full rounded-md px-4 py-2 font-medium disabled:opacity-60"
			type="submit"
			disabled={submitting}
		>
			{submitting ? m['auth.setup.submitting']() : m['auth.setup.submit']()}
		</button>
	</form>
</section>
