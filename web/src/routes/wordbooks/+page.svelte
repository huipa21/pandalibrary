<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { wordbooks, type Wordbook, type WordbookEntry, type WordbookOptions } from '#lib/wordbooks/api.js';
	import Entry from '#lib/wordbooks/Entry.svelte';
	import Header from '#lib/wordbooks/Header.svelte';
	import WordbookDialog from '#lib/wordbooks/WordbookDialog.svelte';
	import BookCover from '#lib/bookview/BookCover.svelte';
	import {
		downloadWordbook, filterEntries, filterWordbooks, involvedBookCount, readPreferences,
		sortEntries, writePreferences, type Category, type EntrySort, type EntryView
	} from '#lib/wordbooks/management.js';

	let books = $state<Wordbook[]>([]);
	let cached = $state<Record<number, WordbookEntry[]>>({});
	let loading = $state(true);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let view = $state<EntryView>('cards');
	let sort = $state<EntrySort>('chronological');
	let category = $state<Category>('wordbooks');
	let keyword = $state('');
	let settingsOpen = $state(false);
	let coverSize = $state(208);
	let spacing = $state(20);
	let showArchived = $state(false);
	let showDescriptions = $state(true);
	let showSources = $state(true);
	let nameMode = $state<'new' | 'rename' | null>(null);
	let disposed = false;
	const selectedId = $derived(Number(page.url.searchParams.get('id')) || null);
	const selected = $derived(books.find((book) => book.id === selectedId));
	const entries = $derived(selectedId === null ? [] : cached[selectedId] ?? []);
	const sorted = $derived(sortEntries(filterEntries(entries, category, keyword), sort));
	const visibleBooks = $derived(filterWordbooks(books, cached, category, keyword, showArchived, sort));

	$effect(() => {
		const id = selectedId;
		untrack(() => {
			const saved = readPreferences(id ?? 0, id === null ? 'cards' : 'list');
			view = saved.view;
			sort = saved.sort;
			keyword = '';
			category = 'wordbooks';
			nameMode = null;
			notice = '';
		});
	});

	onMount(() => {
		void initialize();
		return () => { disposed = true; };
	});
	function showError(cause: unknown) { error = cause instanceof Error ? cause.message : String(cause); }
	async function initialize() {
		loading = true;
		error = '';
		try {
			const result = await wordbooks.list();
			if (disposed) return;
			books = result;
			// Entry categories search all of the user's notebooks.
			const loaded = await Promise.allSettled(result.map(async (book) => [book.id, await wordbooks.entries(book.id)] as const));
			if (disposed) return;
			const failed: string[] = [];
			loaded.forEach((item, index) => {
				if (item.status === 'fulfilled') cached[item.value[0]] = item.value[1];
				else failed.push(`${result[index].name}: ${item.reason instanceof Error ? item.reason.message : String(item.reason)}`);
			});
			if (failed.length) error = failed.join('\n');
		} catch (cause) { if (!disposed) showError(cause); }
		finally { if (!disposed) loading = false; }
	}
	async function navigate(id: number | null) {
		const params = new URLSearchParams(page.url.searchParams.toString());
		if (id === null) params.delete('id'); else params.set('id', String(id));
		try { await goto(`/wordbooks${params.size ? `?${params}` : ''}`, { reset: false }); }
		catch (cause) { showError(cause); }
	}
	async function operate(action: () => Promise<void>): Promise<boolean> {
		if (busy) return false;
		busy = true;
		error = '';
		notice = '';
		try { await action(); return true; }
		catch (cause) { showError(cause); return false; }
		finally { busy = false; }
	}
	function changePreferences(nextView: EntryView, nextSort: EntrySort) {
		view = nextView;
		sort = nextSort;
		writePreferences(selectedId ?? 0, { view, sort });
	}
	function beginName(mode: 'new' | 'rename') {
		nameMode = mode;
	}
	async function saveName(name: string, options: WordbookOptions) {
		const mode = nameMode;
		busy = true;
		error = '';
		notice = '';
		try {
			if (mode === 'new') {
				const book = await wordbooks.create(name, options);
				books = [...books, book];
				cached[book.id] = [];
				await navigate(book.id);
			} else if (selected) {
				const book = await wordbooks.update(selected.id, { name, ...options });
				books = books.map((item) => item.id === book.id ? book : item);
			}
		} finally { busy = false; }
	}
	async function archive() {
		const book = selected;
		if (!book || book.is_default) return;
		await operate(async () => {
			const updated = await wordbooks.update(book.id, { archived: !book.archived });
			books = books.map((item) => item.id === book.id ? updated : item);
			if (updated.archived && !showArchived) await navigate(null);
		});
	}
	function replaceEntries(id: number, next: WordbookEntry[]) {
		cached[id] = next;
		books = books.map((book) => book.id === id ? { ...book, entry_count: next.length, book_count: involvedBookCount(next) } : book);
	}
	async function saveEntry(id: number, changes: { text: string; definition?: string; note?: string }) {
		const bookId = selectedId;
		if (bookId === null || selected?.archived) return false;
		return operate(async () => {
			const updated = await wordbooks.edit(bookId, id, changes);
			replaceEntries(bookId, cached[bookId].map((item) => item.id === id ? updated : item));
		});
	}
	async function deleteEntry(id: number) {
		const bookId = selectedId;
		if (bookId === null || selected?.archived) return;
		await operate(async () => {
			await wordbooks.remove(bookId, id);
			replaceEntries(bookId, cached[bookId].filter((item) => item.id !== id));
		});
	}
	async function exportBook() {
		const book = selected;
		if (!book) return;
		await operate(async () => downloadWordbook(book.name, await wordbooks.export(book.id)));
	}
	async function importBook(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		const id = selectedId;
		input.value = '';
		if (!file || id === null || selected?.archived) return;
		await operate(async () => {
			const result = await wordbooks.import(id, file);
			replaceEntries(id, await wordbooks.entries(id));
			notice = m['wordbooks.imported']({ count: result.imported });
		});
	}
</script>

<svelte:head><title>{m['wordbooks.title']()} · {m['common.app_name']()}</title></svelte:head>

<section class="min-w-0 space-y-5" aria-label={m['wordbooks.title']()} aria-busy={busy || loading}>
	{#if selectedId !== null}
		<div class="flex flex-wrap items-center gap-3">
			<a href="/wordbooks" class="action">{m['wordbooks.back']()}</a>
			{#if selected}<h2 class="text-xl font-semibold">{selected.name}</h2>
				<span class="text-sm text-slate-500">{m['wordbooks.book_count']({ count: selected.book_count ?? involvedBookCount(entries) })}</span>
			{/if}
		</div>
	{/if}
	<Header bind:category bind:keyword bind:size={coverSize} bind:spacing {sort} {view} inside={selectedId !== null} {settingsOpen} disabled={busy || loading} onchange={changePreferences} onsettings={() => settingsOpen = !settingsOpen} oncreate={() => beginName('new')} />
	{#if selectedId === null}
		<label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={showArchived} />{m['wordbooks.show_archived']()}</label>
	{:else if settingsOpen}
		<div class="flex flex-wrap gap-4 rounded-md border border-slate-200 p-3 text-sm" aria-label={m['wordbooks.display_settings']()}>
			<label class="flex items-center gap-2"><input type="checkbox" bind:checked={showDescriptions} />{m['wordbooks.show_descriptions']()}</label>
			<label class="flex items-center gap-2"><input type="checkbox" bind:checked={showSources} />{m['wordbooks.show_sources']()}</label>
			<label class="flex items-center gap-2"><input type="checkbox" bind:checked={showArchived} />{m['wordbooks.show_archived']()}</label>
		</div>
	{/if}
	{#if error}<p role="alert" class="whitespace-pre-wrap break-words rounded-md border border-red-200 bg-red-50 p-3 text-red-800">{error}</p>{/if}
	{#if notice}<p role="status" class="text-sm text-green-800">{notice}</p>{/if}
	{#if nameMode}
		<WordbookDialog mode={nameMode} book={selected} onsave={saveName} onclose={() => nameMode = null} />
	{/if}
	{#if selected}
		{#if showDescriptions && selected.description}<p class="whitespace-pre-wrap break-words text-slate-600">{selected.description}</p>{/if}
		<div class="flex flex-wrap items-center gap-3">
			{#if selected.archived}<span class="text-sm text-slate-600">{m['wordbooks.archived']()}</span>{/if}
				<button class="button" disabled={busy} onclick={() => beginName('rename')}>{m['wordbooks.rename']()}</button>
				{#if !selected.is_default}<button class="button" disabled={busy} onclick={archive}>{selected.archived ? m['wordbooks.unarchive']() : m['wordbooks.archive']()}</button>{/if}
				<button class="button" disabled={busy} onclick={exportBook}>{m['wordbooks.export']()}</button>
				<label class="button relative cursor-pointer" class:opacity-50={busy || selected.archived}>{m['wordbooks.import']()}<input class="absolute inset-0 w-full cursor-pointer opacity-0" type="file" accept=".json,application/json" aria-label={m['wordbooks.import']()} disabled={busy || selected.archived} onchange={importBook} /></label>
		</div>
		{#if loading}<p role="status">{m['wordbooks.loading']()}</p>
		{:else if !sorted.length && !error}<p class="text-slate-600">{keyword || category !== 'wordbooks' ? m['wordbooks.no_matches']() : m['wordbooks.empty']()}</p>
		{:else}
			<ol data-view={view} aria-label={selected.name} class={view === 'cards' ? 'grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3' : 'divide-y divide-slate-200'}>
				{#each sorted as entry (entry.id)}<li data-entry-id={entry.id} class={view === 'cards' ? 'min-w-0 rounded-lg border border-slate-200 p-4' : 'min-w-0 py-5'}><Entry {entry} showSources={showSources} disabled={busy || selected.archived} onsave={saveEntry} ondelete={deleteEntry} /></li>{/each}
			</ol>
		{/if}
	{:else if selectedId === null}
		{#if loading}<p role="status">{m['wordbooks.loading']()}</p>{/if}
		<ul data-wordbooks data-view={view} class={view === 'cards' ? 'book-grid book-grid-configurable' : 'space-y-3'} style={`--book-cover-size: ${coverSize}px; --book-cover-spacing: ${spacing}px`}>
			{#each visibleBooks as book (book.id)}
				<li class="min-w-0">
					<a href="/wordbooks?id={book.id}" aria-label={book.name} class={view === 'cards' ? 'notebook book-tile-lift group block min-w-0 focus-visible:outline-2' : 'notebook group flex min-w-0 gap-4 rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400 focus-visible:outline-2'}>
						<div class="relative shrink-0" class:w-20={view === 'list'}>
							<BookCover id={book.id} title={book.name} coverColor={book.cover_color} coverUrl={book.cover_image} centeredTitle size={view === 'cards' ? 'md' : 'sm'} />
							<span data-entry-count class="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-1 text-xs text-slate-700" aria-label={m['wordbooks.entry_count']({ count: book.entry_count ?? cached[book.id]?.length ?? 0 })}>{book.entry_count ?? cached[book.id]?.length ?? 0}</span>
							<span data-book-count class="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-white/90 px-2 py-1 text-xs text-slate-700" aria-label={m['wordbooks.book_count']({ count: book.book_count ?? involvedBookCount(cached[book.id] ?? []) })}>
								{book.book_count ?? involvedBookCount(cached[book.id] ?? [])}
								<svg aria-hidden="true" viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1m0-15c3-2 6-2 10-1v15c-4-1-7-1-10 1V5Z" /></svg>
							</span>
						</div>
						{#if view === 'list'}
						<div class="min-w-0 flex-1"><h2 class="break-words font-semibold">{book.name}</h2>
							{#if showDescriptions && book.description}<p class="mt-1 line-clamp-2 break-words text-sm text-slate-500">{book.description}</p>{/if}
							{#if book.archived}<span class="text-xs text-slate-500">{m['wordbooks.archived']()}</span>{/if}
						</div>
						{:else if book.archived}<span class="mt-1 block text-xs text-slate-500">{m['wordbooks.archived']()}</span>{/if}
					</a>
				</li>
			{/each}
		</ul>
		{#if !loading && !visibleBooks.length && !error}<p class="text-slate-600">{m['wordbooks.no_matches']()}</p>{/if}
	{:else if !loading && !error}<p role="alert">{m['wordbooks.no_matches']()}</p>{/if}
</section>

<style>
	.button { display: inline-block; min-height: 2.5rem; border: 1px solid #cbd5e1; border-radius: .375rem; padding: .5rem .75rem; background: white; font-size: .875rem; }
	.button:disabled { opacity: .5; cursor: not-allowed; }
	.button:focus-visible, .button:focus-within, input:focus-visible { outline: 2px solid #0f172a; outline-offset: 2px; }
	.action { text-decoration: underline; text-underline-offset: .2em; }
</style>
