<script lang="ts">
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { catalogErrorMessage } from '#lib/catalog/errors.js';
	import { getBook } from '#lib/catalog/api.js';
	import type { Book } from '#lib/catalog/types.js';

	let book = $state<Book | null>(null);
	let loading = $state(true);
	let error = $state('');
	let requestVersion = 0;

	$effect(() => {
		const id = page.params.id ?? '';
		void loadBook(id);
	});

	async function loadBook(id: string) {
		const request = ++requestVersion;
		book = null;
		loading = true;
		error = '';
		const parsedID = Number(id);
		if (!Number.isSafeInteger(parsedID) || parsedID < 1) {
			error = m['catalog.error.not_found']();
			loading = false;
			return;
		}
		try {
			book = await getBook(parsedID);
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

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let size = bytes / 1024;
		let unit = 0;
		while (size >= 1024 && unit < units.length - 1) {
			size /= 1024;
			unit += 1;
		}
		return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`;
	}

	function roleLabel(role: string): string {
		switch (role) {
			case 'author': return m['catalog.book.role.author']();
			case 'translator': return m['catalog.book.role.translator']();
			case 'editor': return m['catalog.book.role.editor']();
			case 'illustrator': return m['catalog.book.role.illustrator']();
			default: return role;
		}
	}
</script>

{#if error}
	<div class="space-y-4" role="alert">
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{error}</p>
		<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => loadBook(page.params.id ?? '')}>{m['catalog.retry']()}</button>
		<a class="underline underline-offset-4 focus-visible:outline-2" href="/">{m['catalog.back_to_libraries']()}</a>
	</div>
{:else if loading}
	<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
{:else if book}
	<article class="space-y-8">
		<header class="space-y-3">
			<a class="text-sm text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2" href={`/library/${book.library_id}`}>
				{m['catalog.back_to_library']()}
			</a>
			<h1 class="text-3xl font-semibold tracking-tight">{book.title}</h1>
			{#if book.subtitle}<p class="text-xl text-slate-600">{book.subtitle}</p>{/if}
		</header>

		<div class="grid gap-8 md:grid-cols-[minmax(12rem,18rem)_1fr]">
			<aside class="space-y-3">
				{#if book.cover_url}
					<img class="w-full rounded-lg bg-slate-100 object-contain" src={book.cover_url} alt={book.title} />
				{:else}
					<div class="flex aspect-[3/4] items-center justify-center rounded-lg bg-slate-100 p-4 text-center text-slate-500">
						{m['catalog.book.cover_unavailable']()}
					</div>
				{/if}
				{#if book.cover_source}
					<p class="text-sm text-slate-600">{m['catalog.book.cover_source']()}: {book.cover_source}</p>
				{/if}
			</aside>

			<div class="space-y-8">
				<section aria-labelledby="book-details-heading" class="space-y-3">
					<h2 id="book-details-heading" class="text-xl font-semibold">{m['catalog.book.details']()}</h2>
					<dl class="grid gap-x-4 gap-y-3 sm:grid-cols-[max-content_1fr]">
						{#if book.authors.length}
							<dt class="font-medium">{m['catalog.book.contributors']()}</dt>
							<dd>
								<ul class="space-y-1">
									{#each book.authors as author (author.id)}
										<li>
											<a class="underline-offset-4 hover:underline" href={`/authors/${author.id}`}>{author.name}</a>
											<span class="text-slate-600">({roleLabel(author.role)})</span>
										</li>
									{/each}
								</ul>
							</dd>
						{/if}
						{#if book.series}
							<dt class="font-medium">{m['catalog.book.series']()}</dt>
							<dd>
								<a class="underline-offset-4 hover:underline" href={`/series/${book.series.id}`}>{book.series.name}</a>
								{#if book.series.index !== null}<span class="text-slate-600"> · {book.series.index}</span>{/if}
							</dd>
						{/if}
						{#if book.language}
							<dt class="font-medium">{m['catalog.book.language']()}</dt><dd>{book.language}</dd>
						{/if}
						{#if book.publisher}
							<dt class="font-medium">{m['catalog.book.publisher']()}</dt><dd>{book.publisher}</dd>
						{/if}
						{#if book.published_date}
							<dt class="font-medium">{m['catalog.book.published']()}</dt><dd>{book.published_date}</dd>
						{/if}
						{#if book.page_count !== null}
							<dt class="font-medium">{m['catalog.book.page_count']()}</dt><dd>{book.page_count}</dd>
						{/if}
					</dl>
					{#if book.description}
						<div class="pt-2">
							<h3 class="font-medium">{m['catalog.book.description']()}</h3>
							<p class="mt-2 whitespace-pre-wrap leading-7 text-slate-700">{book.description}</p>
						</div>
					{/if}
				</section>

				{#if book.tags.length}
					<section aria-labelledby="book-tags-heading" class="space-y-2">
						<h2 id="book-tags-heading" class="font-semibold">{m['catalog.book.tags']()}</h2>
						<ul class="flex flex-wrap gap-2">
							{#each book.tags as tag (tag.id)}
								<li><a class="rounded-full border border-slate-300 px-3 py-1 text-sm underline-offset-4 hover:underline" href={`/tags/${tag.id}`}>{tag.name}</a></li>
							{/each}
						</ul>
					</section>
				{/if}

				<section aria-labelledby="book-files-heading" class="space-y-3">
					<h2 id="book-files-heading" class="text-xl font-semibold">{m['catalog.book.files']()}</h2>
					{#if book.files.length}
						<ul class="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
							{#each book.files as file (file.id)}
								<li class="flex flex-wrap items-center justify-between gap-3 p-4">
									<span class="font-medium">{file.format.toUpperCase()} · {formatSize(file.size_bytes)}</span>
									<a class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" href={file.download_url}>
										{m['catalog.book.download']()}
									</a>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-slate-600">{m['catalog.book.no_files']()}</p>
					{/if}
				</section>

				{#if book.identifiers.length}
					<section aria-labelledby="book-identifiers-heading" class="space-y-2">
						<h2 id="book-identifiers-heading" class="font-semibold">{m['catalog.book.identifiers']()}</h2>
						<ul class="space-y-1">
							{#each book.identifiers as identifier (`${identifier.scheme}:${identifier.value}`)}
								<li><span class="font-medium">{identifier.scheme}:</span> {identifier.value}</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if book.field_sources.length}
					<details class="rounded-md border border-slate-200 bg-white p-4">
						<summary class="cursor-pointer font-semibold focus-visible:outline-2">{m['catalog.book.provenance']()}</summary>
						<ul class="mt-3 space-y-2 text-sm text-slate-600">
							{#each book.field_sources as source (`${source.field}:${source.source}:${source.chosen_at}`)}
								<li>{source.field}: {source.source}{#if source.source_ref} · {source.source_ref}{/if}</li>
							{/each}
						</ul>
					</details>
				{/if}
			</div>
		</div>
	</article>
{/if}
