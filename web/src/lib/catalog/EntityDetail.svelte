<script lang="ts">
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { catalogErrorMessage } from './errors.js';
	import { getEntity } from './api.js';
	import BookBrowser from './BookBrowser.svelte';
	import type { BookFilters, CatalogEntity, EntityKind } from './types.js';

	let { kind }: { kind: EntityKind } = $props();
	let entity = $state<CatalogEntity | null>(null);
	let loading = $state(true);
	let error = $state('');
	let requestVersion = 0;
	const indexTitle = $derived(
		kind === 'authors'
			? m['catalog.entities.authors']()
			: kind === 'series'
				? m['catalog.entities.series']()
				: m['catalog.entities.tags']()
	);
	const scope = $derived.by((): BookFilters => {
		if (!entity) return {};
		if (kind === 'authors') return { author_id: entity.id };
		if (kind === 'series') return { series_id: entity.id };
		return { tag_id: entity.id };
	});

	$effect(() => {
		const id = page.params.id ?? '';
		void loadEntity(id);
	});

	async function loadEntity(id: string) {
		const request = ++requestVersion;
		entity = null;
		loading = true;
		error = '';
		const parsedID = Number(id);
		if (!Number.isSafeInteger(parsedID) || parsedID < 1) {
			error = m['catalog.error.not_found']();
			loading = false;
			return;
		}
		try {
			entity = await getEntity(kind, parsedID);
		} catch (cause) {
			if (request !== requestVersion) return;
			error = catalogErrorMessage(cause, {
				api: m['catalog.error.api'](),
				connection: m['catalog.error.connection'](),
				notFound: m['catalog.error.not_found']()
			});
		} finally {
			if (request === requestVersion) loading = false;
		}
	}
</script>

{#if error}
	<div class="space-y-4" role="alert">
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{error}</p>
		<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => loadEntity(page.params.id ?? '')}>{m['catalog.retry']()}</button>
		<a class="underline underline-offset-4 focus-visible:outline-2" href={`/${kind}`}>{indexTitle}</a>
	</div>
{:else if loading}
	<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
{:else if entity}
	<section class="space-y-8">
		<header class="space-y-3">
			<a class="text-sm text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2" href={`/${kind}`}>{indexTitle}</a>
			<h1 class="text-3xl font-semibold tracking-tight">{entity.name}</h1>
			<p class="text-sm text-slate-600">{entity.visible_book_count} {m['catalog.book_count']()}</p>
			{#if kind === 'series' && entity.description}
				<p class="max-w-3xl leading-7 text-slate-700">{entity.description}</p>
			{/if}
		</header>
		<BookBrowser {scope} />
	</section>
{/if}
