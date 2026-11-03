<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { locales, localizeHref, setLocale, type Locale } from '#lib/paraglide/runtime.js';
	import { ApiError, api } from '#lib/api/client.js';
	import { navigation } from '#lib/nav.js';
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
		<div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
			<a class="font-semibold tracking-tight" href="/">{m['common.app_name']()}</a>
			<div class="flex flex-wrap items-center gap-4 sm:gap-6">
				{#if viewer}
					<nav aria-label={m['auth.navigation.label']()} class="flex flex-wrap gap-3 text-sm sm:gap-4">
						{#each navigation as item (item.id)}
							<a
								class="rounded-sm text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
								href={item.href}
								aria-current={page.url.pathname === item.href || (item.href !== '/' && page.url.pathname.startsWith(`${item.href}/`)) ? 'page' : undefined}
							>
								{item.label()}
							</a>
						{/each}
						<a
							class="rounded-sm text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
							href="/settings"
						>
							{m['auth.navigation.settings']()}
						</a>
					</nav>
					<span class="hidden text-sm text-slate-600 lg:inline">
						{viewer.display_name || viewer.username}
					</span>
					<button class="rounded-sm text-sm text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" onclick={logout}>
						{m['auth.logout.submit']()}
					</button>
				{/if}
				<nav aria-label={m['catalog.language.navigation']()} class="flex gap-3 text-sm sm:gap-4">
					{#each locales as locale (locale)}
						<a
							class="rounded-sm text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
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
