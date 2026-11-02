<script lang="ts">
	import { onMount } from 'svelte';
	import { ApiError, api } from '#lib/api/client.js';
	import { setLocale, type Locale } from '#lib/paraglide/runtime.js';
	import * as m from '#lib/paraglide/messages.js';

	interface UserProfile {
		id: number;
		username: string;
		display_name: string;
		role: string;
		locale: Locale;
	}

	interface AppPassword {
		id: number;
		kind: 'opds' | 'kosync';
		label: string;
		created_at: string;
		last_used_at?: string;
		secret?: string;
	}

	let profile = $state<UserProfile | null>(null);
	let passwords = $state<AppPassword[]>([]);
	let displayName = $state('');
	let locale = $state<Locale>('en');
	let kind = $state<'opds' | 'kosync'>('opds');
	let label = $state('');
	let newSecret = $state('');
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);

	onMount(async () => {
		try {
			const [profileResponse, passwordResponse] = await Promise.all([
				api.request<{ user: UserProfile }>('/me/profile'),
				api.request<{ app_passwords: AppPassword[] }>('/me/app-passwords')
			]);
			profile = profileResponse.user;
			displayName = profileResponse.user.display_name;
			locale = profileResponse.user.locale;
			passwords = passwordResponse.app_passwords;
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 401) {
				window.location.assign('/login');
				return;
			}
			error = m['auth.error.connection']();
		}
	});

	async function saveProfile(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		notice = '';
		busy = true;
		try {
			const response = await api.request<{ user: UserProfile }, { display_name: string; locale: string }>(
				'/me/profile',
				{ method: 'PATCH', body: { display_name: displayName, locale } }
			);
			profile = response.user;
			await setLocale(response.user.locale, { reload: false });
			notice = m['auth.profile.saved']();
		} catch {
			error = m['auth.profile.failure']();
		} finally {
			busy = false;
		}
	}

	async function createPassword(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		notice = '';
		newSecret = '';
		busy = true;
		try {
			const response = await api.request<{ app_password: AppPassword }, { kind: string; label: string }>(
				'/me/app-passwords',
				{ method: 'POST', body: { kind, label } }
			);
			newSecret = response.app_password.secret ?? '';
			passwords = [
				{ ...response.app_password, secret: undefined },
				...passwords
			];
			label = '';
			notice = m['auth.app_password.created']();
		} catch {
			error = m['auth.app_password.failure']();
		} finally {
			busy = false;
		}
	}

	async function revokePassword(id: number) {
		error = '';
		notice = '';
		try {
			await api.request<{ revoked: boolean }>(`/me/app-passwords/${id}`, { method: 'DELETE' });
			passwords = passwords.filter((password) => password.id !== id);
			notice = m['auth.app_password.revoked']();
		} catch {
			error = m['auth.app_password.failure']();
		}
	}
</script>

<section class="space-y-10">
	<div>
		<h1 class="text-3xl font-semibold tracking-tight">{m['auth.settings.title']()}</h1>
		<p class="mt-2 text-slate-600">{m['auth.settings.description']()}</p>
	</div>
	{#if error}
		<p class="rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">{error}</p>
	{/if}
	{#if notice}
		<p class="rounded-md border border-green-200 bg-green-50 p-3 text-green-800" role="status">{notice}</p>
	{/if}
	{#if profile}
		<form class="max-w-xl space-y-5" onsubmit={saveProfile}>
			<h2 class="text-xl font-semibold">{m['auth.profile.title']()}</h2>
			<p class="text-sm text-slate-600">{profile.username} · {profile.role}</p>
			<label class="block space-y-2 text-sm font-medium" for="profile-display-name">
				<span>{m['auth.profile.display_name']()}</span>
				<input
					id="profile-display-name"
					class="w-full rounded-md border border-slate-300 px-3 py-2"
					autocomplete="name"
					bind:value={displayName}
				/>
			</label>
			<label class="block space-y-2 text-sm font-medium" for="profile-locale">
				<span>{m['auth.profile.locale']()}</span>
				<select id="profile-locale" class="w-full rounded-md border border-slate-300 px-3 py-2" bind:value={locale}>
					<option value="en">{m['common.language_english']()}</option>
					<option value="zh">{m['common.language_chinese']()}</option>
				</select>
			</label>
			<button class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60" disabled={busy}>
				{m['auth.profile.save']()}
			</button>
		</form>
	{/if}

	<section class="max-w-3xl space-y-5">
		<div>
			<h2 class="text-xl font-semibold">{m['auth.app_password.title']()}</h2>
			<p class="mt-1 text-sm text-slate-600">{m['auth.app_password.description']()}</p>
		</div>
		<form class="grid gap-4 sm:grid-cols-[1fr_1fr_auto]" onsubmit={createPassword}>
			<label class="block space-y-2 text-sm font-medium" for="app-password-kind">
				<span>{m['auth.app_password.kind']()}</span>
				<select id="app-password-kind" class="w-full rounded-md border border-slate-300 px-3 py-2" bind:value={kind}>
					<option value="opds">OPDS</option>
					<option value="kosync">KOReader</option>
				</select>
			</label>
			<label class="block space-y-2 text-sm font-medium" for="app-password-label">
				<span>{m['auth.app_password.label']()}</span>
				<input
					id="app-password-label"
					class="w-full rounded-md border border-slate-300 px-3 py-2"
					maxlength="64"
					required
					bind:value={label}
				/>
			</label>
			<button class="self-end rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60" disabled={busy}>
				{m['auth.app_password.create']()}
			</button>
		</form>
		{#if newSecret}
			<div class="rounded-md border border-amber-300 bg-amber-50 p-4" role="status">
				<p class="font-semibold">{m['auth.app_password.save_once']()}</p>
				<code class="mt-2 block select-all text-lg tracking-wide">{newSecret}</code>
			</div>
		{/if}
		{#if passwords.length}
			<ul class="divide-y divide-slate-200 rounded-md border border-slate-200">
				{#each passwords as password (password.id)}
					<li class="flex items-center justify-between gap-4 p-4">
						<div>
							<p class="font-medium">{password.label}</p>
							<p class="text-sm text-slate-600">{password.kind} · {new Date(password.created_at).toLocaleDateString()}</p>
						</div>
						<button
							class="text-sm font-medium text-red-700 underline-offset-4 hover:underline"
							type="button"
							onclick={() => revokePassword(password.id)}
						>
							{m['auth.app_password.revoke']()}
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-slate-600">{m['auth.app_password.empty']()}</p>
		{/if}
	</section>
</section>
