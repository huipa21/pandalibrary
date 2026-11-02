<script lang="ts">
	import { api } from '#lib/api/client.js';
	import { setLocale, type Locale } from '#lib/paraglide/runtime.js';
	import * as m from '#lib/paraglide/messages.js';

	let username = $state('');
	let password = $state('');
	let error = $state('');
	let submitting = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		submitting = true;
		try {
			const response = await api.request<{ user: { locale: Locale } }>('/auth/login', {
				method: 'POST',
				body: { username, password }
			});
			await setLocale(response.user.locale, { reload: false });
			window.location.assign('/');
		} catch {
			error = m['auth.login.failure']();
			submitting = false;
		}
	}
</script>

<section class="mx-auto max-w-md">
	<h1 class="text-3xl font-semibold tracking-tight">{m['auth.login.title']()}</h1>
	<p class="mt-2 text-slate-600">{m['auth.login.description']()}</p>
	<form class="mt-8 space-y-5" onsubmit={submit}>
		<label class="block space-y-2 text-sm font-medium" for="username">
			<span>{m['auth.login.username']()}</span>
			<input
				id="username"
				class="w-full rounded-md border border-slate-300 px-3 py-2"
				autocomplete="username"
				required
				bind:value={username}
			/>
		</label>
		<label class="block space-y-2 text-sm font-medium" for="password">
			<span>{m['auth.login.password']()}</span>
			<input
				id="password"
				class="w-full rounded-md border border-slate-300 px-3 py-2"
				type="password"
				autocomplete="current-password"
				required
				bind:value={password}
			/>
		</label>
		{#if error}
			<p class="text-sm text-red-700" role="alert">{error}</p>
		{/if}
		<button
			class="w-full rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60"
			type="submit"
			disabled={submitting}
		>
			{submitting ? m['auth.login.submitting']() : m['auth.login.submit']()}
		</button>
	</form>
</section>
