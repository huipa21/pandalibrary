<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { setLocale, type Locale } from '#lib/paraglide/runtime.js';
	import { ApiError, api } from '#lib/api/client.js';
	import BuildVersion from '#lib/buildinfo/BuildVersion.svelte';
	import AppShell from '#lib/shell/AppShell.svelte';
	import ShelfNavigation from '#lib/shelves/ShelfNavigation.svelte';
	import { activateOffline, deactivateOffline, offlineStatus, rememberedViewer, syncNow } from '#lib/sync/client.js';
	import { withSessionLock } from '#lib/sync/engine.js';
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
	let offlineNotice = $state('');
	const publicRoute = $derived(page.url.pathname === '/login' || page.url.pathname === '/setup');

	onMount(() => {
		const accountChanged = () => {
			viewer = null;
			window.location.reload();
		};
		window.addEventListener('pandalibrary-account-invalid', accountChanged);
		void checkAuth();
		return () => window.removeEventListener('pandalibrary-account-invalid', accountChanged);
	});

	async function checkAuth() {
		const path = page.url.pathname;
		try {
			const setup = await api.request<{ required: boolean }>('/setup');
			if (setup.required) {
				await deactivateOffline();
				if (path !== '/setup') await goto('/setup');
				return;
			}

			try {
				const response = await api.request<{ user: Viewer }>('/auth/me');
				await activateOffline(response.user);
				viewer = response.user;
				await setLocale(response.user.locale, { reload: false });
				if (path === '/login' || path === '/setup') await goto('/');
			} catch (error) {
				if (error instanceof ApiError && error.status === 401) {
					await deactivateOffline();
					if (path !== '/login') await goto('/login');
				} else {
					throw error;
				}
			}
		} catch (error) {
			if (error instanceof TypeError && path !== '/login' && path !== '/setup') {
				try {
					const remembered = await rememberedViewer();
					if (remembered) {
						await activateOffline(remembered, true);
						viewer = remembered;
						await setLocale(remembered.locale, { reload: false });
						return;
					}
				} catch (storageError) {
					console.error('Could not restore the offline session', storageError);
				}
			}
			console.error('Could not check the authenticated session', error);
			authError = m['auth.error.connection']();
		} finally {
			checkingAuth = false;
		}
	}

	async function logout() {
		try {
			await withSessionLock(async () => {
				await api.request<{ logged_out: boolean }>('/auth/logout', { method: 'POST', body: {} });
				await deactivateOffline();
			});
			viewer = null;
			await goto('/login');
		} catch (error) {
			console.error('Could not sign out', error);
			authError = m['auth.error.logout']();
		}
	}

	async function retryOfflineSync() {
		offlineNotice = '';
		try {
			const result = await syncNow(true);
			if (!result.issues) offlineNotice = m['offline.status.synced']();
		} catch (error) {
			console.error('Could not retry offline synchronization', error);
		}
	}
</script>

<svelte:head>
	<title>{m['common.app_name']()}</title>
	<meta name="description" content={m['home.description']()} />
</svelte:head>

<AppShell pathname={page.url.pathname} {viewer} onlogout={logout}>
	{#snippet shelves()}
		<ShelfNavigation pathname={page.url.pathname} />
	{/snippet}
	{#snippet footer()}
		<BuildVersion />
	{/snippet}

	{#if authError}
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">{authError}</p>
	{:else if checkingAuth && !publicRoute}
		<p class="text-slate-600" role="status">{m['auth.loading']()}</p>
	{:else}
		{#if viewer && (!$offlineStatus.available || !$offlineStatus.online || $offlineStatus.issues || $offlineStatus.error || $offlineStatus.pending)}
			<div class="mb-6 flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
				<p>
					{#if !$offlineStatus.available}
						{m['offline.status.unavailable']()}
					{:else if !$offlineStatus.online}
						{m['offline.status.offline']()}
					{:else if $offlineStatus.issues}
						{m['offline.status.conflict']()}
					{:else if $offlineStatus.error}
						{m['offline.status.failed']()}
					{:else}
						{m['offline.status.pending']()}
					{/if}
				</p>
				{#if $offlineStatus.available && $offlineStatus.online}
					<button class="font-medium underline focus-visible:outline-2" onclick={retryOfflineSync}>
						{m['offline.retry_sync']()}
					</button>
				{/if}
			</div>
		{/if}
		{#if offlineNotice}<p class="mb-4 text-sm text-green-700" role="status">{offlineNotice}</p>{/if}
		{@render children()}
	{/if}
</AppShell>
