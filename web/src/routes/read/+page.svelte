<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { listBooks } from '#lib/catalog/api.js';
	import { catalogErrorMessage } from '#lib/catalog/errors.js';
	import type { Book } from '#lib/catalog/types.js';
	import { readerFormat } from '#lib/reader/index.js';
	import { currentAccount, offlineAvailable } from '#lib/sync/client.js';
	import { downloadedBooks } from '#lib/sync/db.js';

	let books = $state<Book[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state('');
	let offline = $state(false);
	const seenCursors = new Set<string>();

	onMount(() => { void load(); });

	async function load(more = false) {
		if (more && (!cursor || loadingMore)) return;
		if (more) loadingMore = true;
		else {
			loading = true;
			books = [];
			cursor = null;
			seenCursors.clear();
		}
		error = '';
		try {
			if (!navigator.onLine) {
				await loadDownloaded();
				return;
			}
			const result = await listBooks({}, 'title', { cursor: more ? cursor : null });
			if (result.next_cursor && seenCursors.has(result.next_cursor)) {
				throw new Error('The catalog returned a repeated cursor.');
			}
			if (result.next_cursor) seenCursors.add(result.next_cursor);
			books = more ? [...books, ...result.items] : result.items;
			cursor = result.next_cursor;
			offline = false;
		} catch (cause) {
			console.error('Could not load books for the reader', cause);
			if (cause instanceof TypeError && offlineAvailable()) {
				try {
					await loadDownloaded();
					return;
				} catch (storageError) {
					console.error('Could not load downloaded books', storageError);
					error = m['offline.storage.failure']();
					return;
				}
			}
			error = catalogErrorMessage(cause, {
				api: m['reader.error.api'](),
				connection: m['reader.error.connection'](),
				notFound: m['reader.error.not_found']()
			});
		} finally {
			loading = false;
			loadingMore = false;
		}
	}

	async function loadDownloaded() {
		if (!offlineAvailable()) throw new Error('Offline storage is unavailable.');
		const downloaded = await downloadedBooks(currentAccount());
		books = downloaded.filter((item) => item.fileIds.length > 0).map((item) => ({
			...item.book,
			files: item.book.files.filter((file) => item.fileIds.includes(file.id))
		}));
		cursor = null;
		offline = true;
	}
</script>

<section class="space-y-6">
	<h1 class="sr-only">{m['reader.launch.title']()}</h1>
	{#if offline}<p class="text-sm text-slate-600">{m['offline.only_downloaded']()}</p>{/if}
	{#if loading}
		<p role="status" class="text-slate-600">{m['reader.loading']()}</p>
	{:else}
		{#if error}
			<div role="alert" class="space-y-2 rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
				<p>{error}</p>
				<button class="underline focus-visible:outline-2" onclick={() => load(books.length > 0)}>{m['reader.retry']()}</button>
			</div>
		{/if}
		{#if !books.length && !error}
			<p class="text-slate-600">{m['reader.launch.empty']()}</p>
		{:else if books.length}
			<ul class="divide-y divide-slate-200 card">
				{#each books as book (book.id)}
					<li class="space-y-3 p-4">
						<h2 class="text-lg font-semibold"><a class="underline-offset-4 hover:underline focus-visible:outline-2" href={`/books/${book.id}`}>{book.title}</a></h2>
						{#if book.files.some((file) => readerFormat(file.format))}
							<div class="flex flex-wrap gap-2">
								{#each book.files.filter((file) => readerFormat(file.format)) as file (file.id)}
									<a class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" href={`/read/${book.id}/${file.id}`}>
										{m['reader.launch.open']()} {file.format.toUpperCase()}
									</a>
								{/each}
							</div>
						{:else}
							<p class="text-sm text-slate-600">{m['reader.launch.no_formats']()}</p>
						{/if}
					</li>
				{/each}
			</ul>
			{#if cursor}
				<button class="rounded-md border border-slate-300 px-4 py-2 font-medium focus-visible:outline-2" disabled={loadingMore} onclick={() => load(true)}>
					{loadingMore ? m['reader.launch.loading_more']() : m['reader.launch.load_more']()}
				</button>
			{/if}
		{/if}
	{/if}
</section>
