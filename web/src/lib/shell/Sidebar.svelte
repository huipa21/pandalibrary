<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import * as m from '#lib/paraglide/messages.js';
	import { homeNavigationFor, isActive, navigationFor, type NavigationItem } from '#lib/nav.js';
	import BookheapCount from '#lib/bookheap/BookheapCount.svelte';
	import { requestDashboardConfigure } from '#lib/dashboard/configure.svelte.js';
	import SidebarShelves from './SidebarShelves.svelte';

	interface Props {
		role: string;
		pathname: string;
		/** SHELVES slot. Defaults to the UX1 shelf links. */
		shelves?: Snippet;
		/** Bottom footer slot for build information. */
		footer?: Snippet;
		/** Account controls shown above the footer when the header cannot hold them. */
		account?: Snippet;
	}

	let { role, pathname, shelves, footer, account }: Props = $props();

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
					{#if item.id === 'bookheap'}
						<span class="min-w-0 flex-1 truncate">{item.label()}</span>
						<BookheapCount />
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
	<nav aria-label={m['auth.navigation.label']()} class="shell-scroll min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-3 py-4">
		<section class="shell-section" aria-labelledby="sidebar-home-heading">
			<h2 id="sidebar-home-heading" class="shell-heading">{m['ux1.nav.home_heading']()}</h2>
			{@render links(homeNavigationFor(role))}
		</section>
		{#if shelves}
			{@render shelves()}
		{:else}
			<SidebarShelves {pathname} {role} />
		{/if}
		<section class="shell-section" aria-labelledby="sidebar-browse-heading">
			<h2 id="sidebar-browse-heading" class="shell-heading">{m['ux1.nav.browse_heading']()}</h2>
			{@render links(navigationFor(role))}
		</section>
	</nav>
	{@render account?.()}
	<footer class="shell-sidebar-footer shrink-0 border-t px-6 py-3 text-xs" data-slot="sidebar-footer">
		{@render footer?.()}
	</footer>
</div>
