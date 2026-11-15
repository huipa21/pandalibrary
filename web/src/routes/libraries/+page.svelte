<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { catalogErrorMessage } from '#lib/catalog/errors.js';
	import { listLibraries } from '#lib/catalog/api.js';
	import { hasNextPage } from '#lib/catalog/query.js';
	import type { Library } from '#lib/catalog/types.js';
	import { getSessionViewer } from '#lib/shelves/api.js';
	import { isAdministrator } from '#lib/shelves/form.js';
	import EntityManagementCover from '#lib/EntityManagementCover.svelte';
	import { entityIcon } from '#lib/navigation-icons.js';
	import LibraryCreateDialog from '#lib/libraries/LibraryCreateDialog.svelte';

	let libraries = $state<Library[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state('');
	let moreError = $state('');
	let isAdmin = $state(false);
	let dialogOpen = $state(false);
	let loadVersion = 0;

	$effect(() => {
		if (isAdmin && page.url.searchParams.get('create') === '1') dialogOpen = true;
	});

	function closeCreate() {
		dialogOpen = false;
		if (page.url.searchParams.get('create') === '1') {
			const url = new URL(page.url.href);
			url.searchParams.delete('create');
			void goto(`${url.pathname}${url.search}`, { replace: true, reset: false });
		}
	}

	onMount(() => {
		void loadLibraries();
		const changed = () => { void loadLibraries(); };
		window.addEventListener('pandalibrary-libraries-changed', changed);
		return () => {
			loadVersion++;
			window.removeEventListener('pandalibrary-libraries-changed', changed);
		};
	});

	async function loadLibraries() {
		const version = ++loadVersion;
		loading = true;
		loadingMore = false;
		error = '';
		moreError = '';
		libraries = [];
		nextCursor = null;
		try {
			const [result, viewer] = await Promise.all([listLibraries(), getSessionViewer()]);
			if (version !== loadVersion) return;
			libraries = result.items;
			nextCursor = result.next_cursor;
			isAdmin = isAdministrator(viewer);
		} catch (cause) {
			if (version !== loadVersion) return;
			error = catalogErrorMessage(cause, {
				api: m['catalog.error.api'](),
				connection: m['catalog.error.connection'](),
				notFound: m['catalog.error.not_found']()
			});
		} finally {
			if (version === loadVersion) loading = false;
		}
	}

	async function loadMore() {
		if (!nextCursor || loadingMore) return;
		const version = loadVersion;
		loadingMore = true;
		moreError = '';
		try {
			const result = await listLibraries({ cursor: nextCursor });
			if (version !== loadVersion) return;
			libraries = [...libraries, ...result.items];
			nextCursor = result.next_cursor;
		} catch (cause) {
			if (version !== loadVersion) return;
			moreError = catalogErrorMessage(cause, {
				api: m['catalog.error.api'](),
				connection: m['catalog.error.connection'](),
				notFound: m['catalog.error.not_found']()
			});
		} finally {
			if (version === loadVersion) loadingMore = false;
		}
	}
</script>

<svelte:head>
	<title>{m['ux1.library.manage']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="libraries-heading">
	<header class="flex flex-wrap items-center justify-between gap-4">
		<h1 id="libraries-heading" class="text-3xl font-semibold tracking-tight">{m['ux1.library.manage']()}</h1>
	</header>
	{#if error}
		<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
			<p>{error}</p>
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={loadLibraries}>{m['catalog.retry']()}</button>
		</div>
	{:else if loading}
		<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
	{:else if libraries.length === 0}
		<p class="card p-6 text-slate-600">{m['catalog.home.empty']()}</p>
	{:else}
		<ul class="book-grid book-grid-configurable" style="--book-cover-size: 208px; --book-cover-spacing: 20px">
			{#each libraries as library (library.id)}
				<li class="min-w-0 space-y-3">
					<EntityManagementCover href={`/libraries/${library.id}`} name={library.name} icon={entityIcon(library.icon, `library:${library.id}`)} />
					<div class="min-w-0">
						<h2 class="font-semibold break-words">{library.name}</h2>
						<p class="text-sm text-slate-600">{m['catalog.library.book_count']({ count: library.visible_book_count })}</p>
						<p class="break-words text-sm text-slate-500">{library.slug}</p>
					</div>
				</li>
			{/each}
		</ul>
		{#if moreError}
			<div class="flex flex-wrap items-center gap-3 text-red-800" role="alert">
				<p>{moreError}</p>
				<button class="underline underline-offset-4 focus-visible:outline-2" onclick={loadMore}>{m['catalog.retry']()}</button>
			</div>
		{/if}
		{#if hasNextPage(nextCursor)}
			<button
				class="button-primary rounded-md px-4 py-2 font-medium disabled:opacity-60"
				disabled={loadingMore}
				onclick={loadMore}
			>{loadingMore ? m['catalog.loading_more']() : m['catalog.load_more']()}</button>
		{:else}
			<p class="text-center text-sm text-slate-500" role="status">{m['catalog.end']()}</p>
		{/if}
	{/if}
</section>

{#if isAdmin}
	<LibraryCreateDialog open={dialogOpen} onclose={closeCreate} />
{/if}
