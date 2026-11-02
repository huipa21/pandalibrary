<script lang="ts">
	import { api } from '#lib/api/client.js';
	import { setLocale, type Locale } from '#lib/paraglide/runtime.js';
	import * as m from '#lib/paraglide/messages.js';

	let token = $state('');
	let username = $state('');
	let displayName = $state('');
	let password = $state('');
	let locale = $state<Locale>('en');
	let error = $state('');
	let submitting = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		submitting = true;
		try {
			await api.request<{ user: { locale: Locale } }>('/setup', {
				method: 'POST',
				body: { token, username, display_name: displayName, password, locale }
			});
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
		<label class="block space-y-2 text-sm font-medium" for="setup-password">
			<span>{m['auth.login.password']()}</span>
			<input
				id="setup-password"
				class="w-full rounded-md border border-slate-300 px-3 py-2"
				type="password"
				autocomplete="new-password"
				minlength="12"
				required
				bind:value={password}
			/>
		</label>
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
			class="w-full rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60"
			type="submit"
			disabled={submitting}
		>
			{submitting ? m['auth.setup.submitting']() : m['auth.setup.submit']()}
		</button>
	</form>
</section>
