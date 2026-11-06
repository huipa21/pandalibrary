<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { catalogErrorMessage } from './errors.js';
	import { listEntities } from './api.js';
	import { hasNextPage } from './query.js';
	import type { CatalogEntity, EntityKind } from './types.js';

	let { kind }: { kind: EntityKind } = $props();
	let entities = $state<CatalogEntity[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state('');
	let moreError = $state('');

	onMount(() => {
		void loadEntities();
	});

	async function loadEntities() {
		loading = true;
		entities = [];
		nextCursor = null;
		error = '';
		moreError = '';
		try {
			const result = await listEntities(kind);
			entities = result.items;
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
			const result = await listEntities(kind, { cursor: nextCursor });
			entities = [...entities, ...result.items];
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

	const title = $derived(
		kind === 'authors'
			? m['catalog.entities.authors']()
			: kind === 'series'
				? m['catalog.entities.series']()
				: m['catalog.entities.tags']()
	);
</script>

<section class="space-y-6">
	<h1 class="sr-only">{title}</h1>
	{#if error}
		<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
			<p>{error}</p>
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={loadEntities}>{m['catalog.retry']()}</button>
		</div>
	{:else if loading}
		<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
	{:else if entities.length === 0}
		<p class="rounded-md border border-slate-200 bg-white p-6 text-slate-600">{m['catalog.entities.empty']()}</p>
	{:else}
		<ul class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
			{#each entities as entity (entity.id)}
				<li class="flex flex-wrap items-center justify-between gap-3 p-4">
					<a class="font-medium underline-offset-4 hover:underline focus-visible:outline-2" href={`/${kind}/${entity.id}`}>
						{entity.name}
					</a>
					<span class="text-sm text-slate-600">{entity.visible_book_count} {m['catalog.book_count']()}</span>
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
