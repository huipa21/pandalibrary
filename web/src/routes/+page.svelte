<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { catalogErrorMessage } from '#lib/catalog/errors.js';
	import { listLibraries } from '#lib/catalog/api.js';
	import { hasNextPage } from '#lib/catalog/query.js';
	import type { Library } from '#lib/catalog/types.js';

	let libraries = $state<Library[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state('');
	let moreError = $state('');

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
			const result = await listLibraries();
			libraries = result.items;
			nextCursor = result.next_cursor;
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
</script>

<section class="space-y-8">
	<header>
		<h1 class="text-3xl font-semibold tracking-tight">{m['catalog.home.title']()}</h1>
		<p class="mt-2 text-slate-600">{m['catalog.home.description']()}</p>
	</header>

	{#if error}
		<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
			<p>{error}</p>
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={loadLibraries}>{m['catalog.retry']()}</button>
		</div>
	{:else if loading}
		<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
	{:else if libraries.length === 0}
		<p class="rounded-md border border-slate-200 bg-white p-6 text-slate-600">{m['catalog.home.empty']()}</p>
	{:else}
		<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each libraries as library (library.id)}
				<li class="rounded-lg border border-slate-200 bg-white p-5">
					<h2 class="text-lg font-semibold">
						<a class="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" href={`/library/${library.id}`}>
							{library.name}
						</a>
					</h2>
					<p class="mt-2 text-sm text-slate-600">{library.slug}</p>
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
