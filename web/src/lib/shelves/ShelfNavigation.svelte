<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { listShelves, getSystemShelf } from './api.js';
	import ShelfCreateDialog from './ShelfCreateDialog.svelte';
	import type { Shelf } from './types.js';

	/**
	 * UX3: Live sidebar shelf navigation with Unshelved, Favorites, and custom shelves.
	 * Renders the SHELVES slot with a plus button, system shelves, and custom shelf links.
	 */
	let { pathname }: { pathname: string } = $props();

	const pager = new CursorPager<Shelf>();
	let unshelvedShelf = $state<Shelf | null>(null);
	let favoritesShelf = $state<Shelf | null>(null);
	let customShelves = $state<Shelf[]>([]);
	let loadingSystemShelves = $state(true);
	let systemShelvesError = $state('');
	let dialogOpen = $state(false);
	let loadVersion = 0;

	onMount(() => {
		void loadSystemAndCustomShelves();

		const handleShelvesChanged = () => {
			void loadSystemAndCustomShelves();
		};

		window.addEventListener('pandalibrary-shelves-changed', handleShelvesChanged);
		return () => {
			loadVersion += 1;
			window.removeEventListener('pandalibrary-shelves-changed', handleShelvesChanged);
			pager.dispose();
		};
	});

	async function loadSystemAndCustomShelves() {
		const version = ++loadVersion;
		loadingSystemShelves = true;
		systemShelvesError = '';
		try {
			const [unshelved, favorites] = await Promise.all([
				getSystemShelf('unshelved'),
				getSystemShelf('favorites')
			]);
			if (version !== loadVersion) return;
			await pager.reset((cursor, signal) => listShelves({ cursor, signal }));
			if (version !== loadVersion) return;
			if (pager.status === 'error') throw pager.error;
			unshelvedShelf = unshelved;
			favoritesShelf = favorites;
			customShelves = pager.items.filter((s) => !s.system_key);
		} catch (e) {
			if (version !== loadVersion) return;
			console.error('Failed to load shelves:', e);
			systemShelvesError = m['ux1.shelves.error']();
		} finally {
			if (version === loadVersion) loadingSystemShelves = false;
		}
	}

	const current = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
</script>

<section class="shell-section" aria-labelledby="sidebar-shelves-heading" data-slot="sidebar-shelves">
	<div class="flex items-center justify-between gap-2 pr-1">
		<h2 id="sidebar-shelves-heading" class="shell-heading">{m['ux1.shelves.heading']()}</h2>
		<button
			class="shell-icon-button"
			aria-label={m['ux1.shelves.create']()}
			title={m['ux1.shelves.create']()}
			onclick={() => {
				dialogOpen = true;
			}}
		>
			<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
				<path d="M10 4v12M4 10h12" />
			</svg>
		</button>
	</div>

	{#if systemShelvesError}
		<div class="mt-1 space-y-1 px-3 text-sm text-red-300">
			<p>{systemShelvesError}</p>
			<button class="shell-text-button" onclick={() => void loadSystemAndCustomShelves()}>{m['ux1.shelves.retry']()}</button>
		</div>
	{:else if loadingSystemShelves}
		<p class="mt-1 px-3 text-sm text-zinc-400">{m['ux1.shelves.loading']()}</p>
	{:else}
		<ul class="mt-1 space-y-0.5">
			<!-- Unshelved System Shelf -->
			{#if unshelvedShelf}
				{@const href = '/shelves/system/unshelved'}
				<li>
					<a class="shell-link" {href} aria-current={current(href) ? 'page' : undefined}>
						<span class="min-w-0 flex-1 truncate">{m['ux3.shelves.unshelved']()}</span>
						<span class="shell-count" title={m['ux1.shelves.count']({ count: unshelvedShelf.visible_book_count })}>{unshelvedShelf.visible_book_count}</span>
					</a>
				</li>
			{/if}

			<!-- Favorites System Shelf -->
			{#if favoritesShelf}
				{@const href = '/shelves/system/favorites'}
				<li>
					<a class="shell-link" {href} aria-current={current(href) ? 'page' : undefined}>
						<span class="min-w-0 flex-1 truncate">{m['ux3.shelves.favorites']()}</span>
						<span class="shell-count" title={m['ux1.shelves.count']({ count: favoritesShelf.visible_book_count })}>{favoritesShelf.visible_book_count}</span>
					</a>
				</li>
			{/if}

			<!-- Custom Shelves -->
			{#each customShelves as shelf (shelf.id)}
				{@const href = `/shelves/${shelf.id}`}
				<li>
					<a class="shell-link" {href} aria-current={current(href) ? 'page' : undefined}>
						<span class="min-w-0 flex-1 truncate">{shelf.name}</span>
						<span class="shell-count" title={m['ux1.shelves.count']({ count: shelf.visible_book_count })}>{shelf.visible_book_count}</span>
					</a>
				</li>
			{/each}
		</ul>

		{#if pager.empty && !unshelvedShelf && !favoritesShelf}
			<p class="mt-1 px-3 text-sm text-zinc-400">{m['ux1.shelves.empty']()}</p>
		{/if}

		<!-- More shelves link -->
		<a class="shell-link mt-0.5 text-zinc-400" href="/shelves" aria-current={pathname === '/shelves' ? 'page' : undefined}>
			{m['ux1.shelves.more']()}
		</a>
	{/if}
</section>

<!-- Create Dialog -->
<ShelfCreateDialog open={dialogOpen} onclose={() => { dialogOpen = false; }} oncreated={() => {}} />

<style>
</style>
