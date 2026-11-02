<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { locales, localizeHref, setLocale, type Locale } from '#lib/paraglide/runtime.js';
	import { ApiError, api } from '#lib/api/client.js';
	import './layout.css';
	import type { LayoutProps } from './$types';

	interface Viewer {
		id: number;
		username: string;
		display_name: string;
		role: string;
		locale: Locale;
	}

	let { children }: LayoutProps = $props();
	let viewer = $state<Viewer | null>(null);
	let checkingAuth = $state(true);
	let authError = $state('');
	const publicRoute = $derived(page.url.pathname === '/login' || page.url.pathname === '/setup');

	onMount(async () => {
		const path = page.url.pathname;
		try {
			const setup = await api.request<{ required: boolean }>('/setup');
			if (setup.required) {
				if (path !== '/setup') await goto('/setup');
				return;
			}

			try {
				const response = await api.request<{ user: Viewer }>('/auth/me');
				viewer = response.user;
				await setLocale(response.user.locale, { reload: false });
				if (path === '/login' || path === '/setup') await goto('/');
			} catch (error) {
				if (error instanceof ApiError && error.status === 401) {
					if (path !== '/login') await goto('/login');
				} else {
					throw error;
				}
			}
		} catch {
			authError = m['auth.error.connection']();
		} finally {
			checkingAuth = false;
		}
	});

	async function logout() {
		try {
			await api.request<{ logged_out: boolean }>('/auth/logout', { method: 'POST', body: {} });
			viewer = null;
			await goto('/login');
		} catch {
			authError = m['auth.error.logout']();
		}
	}
</script>

<svelte:head>
	<title>{m['common.app_name']()}</title>
	<meta name="description" content={m['home.description']()} />
</svelte:head>

<div class="min-h-screen bg-slate-50 text-slate-950">
	<header class="border-b border-slate-200 bg-white">
		<div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
			<a class="font-semibold tracking-tight" href="/">{m['common.app_name']()}</a>
			<div class="flex items-center gap-6">
				{#if viewer}
					<nav aria-label={m['auth.navigation.label']()} class="flex gap-4 text-sm">
						<a class="text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline" href="/">
							{m['auth.navigation.home']()}
						</a>
						<a
							class="text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline"
							href="/settings"
						>
							{m['auth.navigation.settings']()}
						</a>
					</nav>
					<span class="hidden text-sm text-slate-600 sm:inline">
						{viewer.display_name || viewer.username}
					</span>
					<button class="text-sm text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline" onclick={logout}>
						{m['auth.logout.submit']()}
					</button>
				{/if}
				<nav aria-label="Language" class="flex gap-4 text-sm">
					{#each locales as locale (locale)}
						<a
							class="text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline"
							href={localizeHref(page.url.pathname, { locale })}
							hreflang={locale}
							lang={locale}
						>
							{locale === 'zh'
								? m['common.language_chinese']()
								: m['common.language_english']()}
						</a>
					{/each}
				</nav>
			</div>
		</div>
	</header>
	<main class="mx-auto max-w-5xl px-6 py-16">
		{#if authError}
			<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">{authError}</p>
		{:else if checkingAuth && !publicRoute}
			<p class="text-slate-600" role="status">{m['auth.loading']()}</p>
		{:else}
			{@render children()}
		{/if}
	</main>
</div>
