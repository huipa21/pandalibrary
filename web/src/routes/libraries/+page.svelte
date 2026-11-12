<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { catalogErrorMessage } from '#lib/catalog/errors.js';
	import { listLibraries } from '#lib/catalog/api.js';
	import { hasNextPage } from '#lib/catalog/query.js';
	import type { Library } from '#lib/catalog/types.js';
	import { deleteLibrary } from '#lib/admin/api.js';
	import { adminErrorKey } from '#lib/admin/form.js';
	import { translate } from '#lib/paging/translate.js';
	import { getSessionViewer } from '#lib/shelves/api.js';
	import { isAdministrator } from '#lib/shelves/form.js';

	let libraries = $state<Library[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state('');
	let moreError = $state('');
	let isAdmin = $state(false);
	let deleting = $state<number | null>(null);
	let rowErrors = $state<Record<number, string>>({});
	let notice = $state('');

	onMount(() => {
		void loadLibraries();
	});

	async function loadLibraries() {
		loading = true;
		error = '';
		moreError = '';
		libraries = [];
		nextCursor = null;
		try {
			const [result, viewer] = await Promise.all([listLibraries(), getSessionViewer()]);
			libraries = result.items;
			nextCursor = result.next_cursor;
			isAdmin = isAdministrator(viewer);
		} catch (cause) {
			error = catalogErrorMessage(cause, {
				api: m['catalog.error.api'](),
				connection: m['catalog.error.connection'](),
				notFound: m['catalog.error.not_found']()
			});
		} finally {
			loading = false;
		}
	}

	async function loadMore() {
		if (!nextCursor || loadingMore) return;
		loadingMore = true;
		moreError = '';
		try {
			const result = await listLibraries({ cursor: nextCursor });
			libraries = [...libraries, ...result.items];
			nextCursor = result.next_cursor;
		} catch (cause) {
			moreError = catalogErrorMessage(cause, {
				api: m['catalog.error.api'](),
				connection: m['catalog.error.connection'](),
				notFound: m['catalog.error.not_found']()
			});
		} finally {
			loadingMore = false;
		}
	}

	async function remove(library: Library) {
		if (!isAdmin || deleting !== null) return;
		if (!window.confirm(m['admin.libraries.delete_confirm']({ name: library.name }))) return;
		deleting = library.id;
		rowErrors = { ...rowErrors, [library.id]: '' };
		notice = '';
		try {
			await deleteLibrary(library.id);
			notice = m['admin.libraries.deleted']({ name: library.name });
			window.dispatchEvent(new CustomEvent('pandalibrary-libraries-changed'));
			await loadLibraries();
		} catch (cause) {
			rowErrors = { ...rowErrors, [library.id]: translate(adminErrorKey(cause, 'delete_library')) };
		} finally {
			deleting = null;
		}
	}
</script>

<section class="space-y-8">
	<h1 class="sr-only">{m['catalog.home.title']()}</h1>
	{#if isAdmin}
		<nav class="flex flex-wrap justify-end gap-4" aria-label={m['admin.libraries.title']()}>
			<a class="rounded-sm underline underline-offset-4 focus-visible:outline-2" href="/admin/libraries?create=1">{m['admin.libraries.create_heading']()}</a>
			<a class="rounded-sm underline underline-offset-4 focus-visible:outline-2" href="/admin/libraries">{m['admin.libraries.title']()}</a>
		</nav>
	{/if}
	{#if notice}<p class="text-sm text-green-700" role="status">{notice}</p>{/if}

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
		<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each libraries as library (library.id)}
				<li class="card flex flex-col overflow-hidden">
					<a class="block flex-1 p-5 hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-slate-900" href={`/library/${library.id}`}>
						<h2 class="text-lg font-semibold break-words">{library.name}</h2>
						<p class="mt-2 text-sm text-slate-600">{m['catalog.library.book_count']({ count: library.visible_book_count })}</p>
						<p class="mt-1 break-words text-sm text-slate-500">{library.slug}</p>
					</a>
					{#if isAdmin}
						<div class="flex justify-end gap-1 px-3 pb-3">
							<a class="shell-icon-button" href={`/admin/libraries?edit=${library.id}`} aria-label={m['catalog.library.edit']({ name: library.name })} title={m['catalog.library.edit']({ name: library.name })}>
								<svg aria-hidden="true" viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 5 5M3 21l5-1L21 7a2.1 2.1 0 0 0-5-5L3 15v6Z" /></svg>
							</a>
							<button type="button" class="shell-icon-button text-red-700 disabled:opacity-50" disabled={deleting !== null} onclick={() => remove(library)} aria-label={m['catalog.library.delete']({ name: library.name })} title={m['catalog.library.delete']({ name: library.name })}>
								<svg aria-hidden="true" viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></svg>
							</button>
						</div>
						{#if rowErrors[library.id]}<p class="px-5 pb-4 text-sm text-red-800" role="alert">{rowErrors[library.id]}</p>{/if}
					{/if}
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
				class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
				disabled={loadingMore}
				onclick={loadMore}
			>{loadingMore ? m['catalog.loading_more']() : m['catalog.load_more']()}</button>
		{:else}
			<p class="text-center text-sm text-slate-500" role="status">{m['catalog.end']()}</p>
		{/if}
	{/if}
</section>
