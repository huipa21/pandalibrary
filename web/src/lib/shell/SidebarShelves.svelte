<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { listShelves } from '#lib/shelves/api.js';
	import ShelfActionsMenu from '#lib/shelves/ShelfActionsMenu.svelte';
	import type { Shelf } from '#lib/shelves/types.js';

	/**
	 * UX1 placeholder for the sidebar SHELVES slot: the first page of the existing shelf list.
	 * UX3 replaces this component with `ShelfNavigation`.
	 * Load states are deliberately not live regions so they never compete with page status/alerts.
	 */
	let { pathname, role }: { pathname: string; role: string } = $props();
	const pager = new CursorPager<Shelf>();

	onMount(() => {
		void pager.reset((cursor, signal) => listShelves({ cursor, signal }));
		const refresh = () => void pager.reload();
		window.addEventListener('pandalibrary-shelves-changed', refresh);
		return () => {
			window.removeEventListener('pandalibrary-shelves-changed', refresh);
			pager.dispose();
		};
	});

	const current = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
</script>

<section class="shell-section" aria-labelledby="sidebar-shelves-heading" data-slot="sidebar-shelves">
	<div class="flex items-center justify-between gap-2 pr-1">
		<h2 id="sidebar-shelves-heading" class="shell-heading">{m['ux1.shelves.heading']()}</h2>
		<ShelfActionsMenu {pathname} {role} />
	</div>
	{#if pager.status === 'error'}
		<div class="mt-1 space-y-1 px-3 text-sm text-red-300">
			<p>{m['ux1.shelves.error']()}</p>
			<button class="shell-text-button" onclick={() => pager.retry()}>{m['ux1.shelves.retry']()}</button>
		</div>
	{:else if pager.status !== 'ready'}
		<p class="mt-1 px-3 text-sm text-[color:var(--shell-muted)]">{m['ux1.shelves.loading']()}</p>
	{:else}
		{#if pager.empty}
			<p class="mt-1 px-3 text-sm text-[color:var(--shell-muted)]">{m['ux1.shelves.empty']()}</p>
		{:else}
			<ul class="mt-1 space-y-0.5">
				{#each pager.items as shelf (shelf.id)}
					{@const href = `/shelves/${shelf.id}`}
					<li>
						<a class="shell-link" {href} aria-current={current(href) ? 'page' : undefined}>
							<span class="min-w-0 flex-1 truncate">{shelf.name}</span>
							<span class="shell-count" title={m['ux1.shelves.count']({ count: shelf.visible_book_count })}>{shelf.visible_book_count}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>
