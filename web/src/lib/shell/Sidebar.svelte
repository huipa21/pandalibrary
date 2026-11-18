<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import * as m from '#lib/paraglide/messages.js';
	import { adminNavigationFor, homeNavigationFor, isActive, isAdminRoute, navigationFor, otherNavigationFor, type NavigationItem } from '#lib/nav.js';
	import BookheapCount from '#lib/bookheap/BookheapCount.svelte';
	import AnnotationsCount from '#lib/notes/AnnotationsCount.svelte';
	import FavoritesCount from '#lib/shelves/FavoritesCount.svelte';
	import WordbooksCount from '#lib/wordbooks/WordbooksCount.svelte';
	import { requestDashboardConfigure } from '#lib/dashboard/configure.svelte.js';
	import SidebarShelves from './SidebarShelves.svelte';
	import Icon from '#lib/bookview/Icon.svelte';

	interface Props {
		role: string;
		pathname: string;
		/** Library navigation slot. */
		shelves?: Snippet;
		/** Bottom footer slot for build information. */
		footer?: Snippet;
		/** Account controls shown above the footer when the header cannot hold them. */
		account?: Snippet;
	}

	let { role, pathname, shelves, footer, account }: Props = $props();
	const adminMode = $derived(role === 'admin' && isAdminRoute(pathname));

	function configureDashboard(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
		requestDashboardConfigure(event.currentTarget);
		if (pathname !== '/') void goto('/');
	}
</script>

{#snippet links(items: readonly NavigationItem[])}
	<ul class="mt-1 space-y-0.5">
		{#each items as item (item.id)}
			<li class="relative">
				<a class={item.id === 'dashboard' ? 'shell-link pr-9' : 'shell-link'} href={item.href} aria-current={isActive(item, pathname) ? 'page' : undefined}>
					<Icon name={item.icon} class="size-4.5 shrink-0" />
					{#if item.id === 'bookheap'}
						<span class="min-w-0 flex-1 truncate">{item.label()}</span>
						<BookheapCount />
					{:else if item.id === 'notes'}
						<span class="min-w-0 flex-1 truncate">{item.label()}</span>
						<AnnotationsCount {pathname} />
					{:else if item.id === 'favorites'}
						<span class="min-w-0 flex-1 truncate">{item.label()}</span>
						<FavoritesCount />
					{:else if item.id === 'wordbooks'}
						<span class="min-w-0 flex-1 truncate">{item.label()}</span>
						<WordbooksCount />
					{:else}
						{item.label()}
					{/if}
				</a>
				{#if item.id === 'dashboard'}
					<button type="button" class="shell-icon-button absolute top-1/2 right-1 -translate-y-1/2" aria-haspopup="dialog" aria-label={m['ux5.configure']()} title={m['ux5.configure']()} onclick={configureDashboard}>
						<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4" fill="currentColor"><circle cx="10" cy="4" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="10" cy="16" r="1.6" /></svg>
					</button>
				{/if}
			</li>
		{/each}
	</ul>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<nav aria-label={adminMode ? m['admin.tabs.label']() : m['auth.navigation.label']()} class="flex min-h-0 flex-1 flex-col px-3 py-4">
		<div class="shell-scroll min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain">
			{#if adminMode}
				{@render links(adminNavigationFor(role))}
			{:else}
				<section class="shell-section" aria-labelledby="sidebar-home-heading">
					<h2 id="sidebar-home-heading" class="shell-heading">{m['ux1.nav.home_heading']()}</h2>
					{@render links(homeNavigationFor(role))}
				</section>
				{#if shelves}
					{@render shelves()}
				{:else}
					<SidebarShelves {pathname} {role} />
				{/if}
				<section class="shell-section" aria-labelledby="sidebar-statistics-heading">
					<h2 id="sidebar-statistics-heading" class="shell-heading">{m['organize.statistics']()}</h2>
					{@render links(navigationFor(role))}
				</section>
				<section class="shell-section" aria-labelledby="sidebar-others-heading">
					<h2 id="sidebar-others-heading" class="shell-heading">{m['ux1.nav.others_heading']()}</h2>
					{@render links(otherNavigationFor(role))}
				</section>
			{/if}
		</div>
		{#if role === 'admin'}
			<div class="mt-3 shrink-0" data-slot="sidebar-admin">
				<a class="shell-link" href={adminMode ? '/' : '/admin'}>
					<Icon name={adminMode ? 'arrow-left' : 'users'} class="size-4.5 shrink-0" />
					<span>{adminMode ? m['admin.exit_nav']() : m['admin.nav']()}</span>
				</a>
			</div>
		{/if}
	</nav>
	{@render account?.()}
	<footer class="shell-sidebar-footer shrink-0 border-t px-6 py-3 text-xs" data-slot="sidebar-footer">
		{@render footer?.()}
	</footer>
</div>
