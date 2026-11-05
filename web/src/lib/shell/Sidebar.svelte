<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { homeNavigation, isActive, navigationFor, type NavigationItem } from '#lib/nav.js';
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
</script>

{#snippet links(items: readonly NavigationItem[])}
	<ul class="mt-1 space-y-0.5">
		{#each items as item (item.id)}
			<li>
				<a class="shell-link" href={item.href} aria-current={isActive(item, pathname) ? 'page' : undefined}>
					{item.label()}
				</a>
			</li>
		{/each}
	</ul>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<nav aria-label={m['auth.navigation.label']()} class="shell-scroll min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-3 py-4">
		<section class="shell-section" aria-labelledby="sidebar-home-heading">
			<h2 id="sidebar-home-heading" class="shell-heading">{m['ux1.nav.home_heading']()}</h2>
			{@render links(homeNavigation)}
		</section>
		{#if shelves}
			{@render shelves()}
		{:else}
			<SidebarShelves {pathname} />
		{/if}
		<section class="shell-section" aria-labelledby="sidebar-browse-heading">
			<h2 id="sidebar-browse-heading" class="shell-heading">{m['ux1.nav.browse_heading']()}</h2>
			{@render links(navigationFor(role))}
		</section>
	</nav>
	{@render account?.()}
	<footer class="shrink-0 border-t border-white/10 px-6 py-3 text-xs text-zinc-300" data-slot="sidebar-footer">
		{@render footer?.()}
	</footer>
</div>
