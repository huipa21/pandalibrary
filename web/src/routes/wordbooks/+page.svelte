<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { wordbooks, type Wordbook, type WordbookEntry } from '#lib/wordbooks/api.js';
	import Entry from '#lib/wordbooks/Entry.svelte';
	import Header from '#lib/wordbooks/Header.svelte';
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
	let showArchived = $state(false);
	let showDescriptions = $state(true);
	let showSources = $state(true);
	let nameMode = $state<'new' | 'rename' | null>(null);
	let name = $state('');
	let description = $state('');
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
		name = mode === 'rename' ? selected?.name ?? '' : '';
		description = mode === 'rename' ? selected?.description ?? '' : '';
	}
	async function saveName(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim()) return;
		const mode = nameMode;
		const options = { description: description.trim() };
		await operate(async () => {
			if (mode === 'new') {
				const book = await wordbooks.create(name.trim(), options);
				books = [...books, book];
				cached[book.id] = [];
				await navigate(book.id);
			} else if (selected) {
				const book = await wordbooks.update(selected.id, { name: name.trim(), ...options });
				books = books.map((item) => item.id === book.id ? book : item);
			}
			nameMode = null;
		});
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
	<Header bind:category bind:keyword {sort} {view} inside={selectedId !== null} {settingsOpen} disabled={busy || loading} onchange={changePreferences} onsettings={() => settingsOpen = !settingsOpen} oncreate={() => beginName('new')} />
	{#if settingsOpen}
		<div class="flex flex-wrap gap-4 rounded-md border border-slate-200 p-3 text-sm" aria-label={m['wordbooks.display_settings']()}>
			<label class="flex items-center gap-2"><input type="checkbox" bind:checked={showDescriptions} />{m['wordbooks.show_descriptions']()}</label>
			<label class="flex items-center gap-2"><input type="checkbox" bind:checked={showSources} />{m['wordbooks.show_sources']()}</label>
			<label class="flex items-center gap-2"><input type="checkbox" bind:checked={showArchived} />{m['wordbooks.show_archived']()}</label>
		</div>
	{/if}
	{#if error}<p role="alert" class="whitespace-pre-wrap break-words rounded-md border border-red-200 bg-red-50 p-3 text-red-800">{error}</p>{/if}
	{#if notice}<p role="status" class="text-sm text-green-800">{notice}</p>{/if}
	{#if nameMode}
		<form class="space-y-4 rounded-lg border border-slate-200 p-4" onsubmit={saveName} aria-label={nameMode === 'new' ? m['wordbooks.new']() : m['wordbooks.rename']()}>
			<label class="block space-y-1"><span class="text-sm font-medium">{m['wordbooks.name']()}</span><input class="field" required maxlength="200" bind:value={name} disabled={busy} /></label>
			<label class="block space-y-1"><span class="text-sm font-medium">{m['wordbooks.description']()}</span><textarea class="field" rows="2" maxlength="2000" bind:value={description} disabled={busy}></textarea></label>
			<div class="flex gap-3"><button class="button" type="submit" disabled={busy || !name.trim()}>{nameMode === 'new' ? m['wordbooks.create']() : m['wordbooks.save']()}</button><button class="button" type="button" disabled={busy} onclick={() => nameMode = null}>{m['wordbooks.cancel']()}</button></div>
		</form>
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
		<ul data-wordbooks data-view={view} class={view === 'cards' ? 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'space-y-3'}>
			{#each visibleBooks as book (book.id)}
				<li class="min-w-0">
					<a href="/wordbooks?id={book.id}" class="notebook group relative flex min-w-0 gap-4 rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400 focus-visible:outline-2" class:flex-col={view === 'cards'}>
						<span class="absolute right-3 top-3 rounded-full bg-white/90 px-2 py-1 text-xs text-slate-600">{m['wordbooks.entry_count']({ count: book.entry_count ?? cached[book.id]?.length ?? 0 })}</span>
						<div aria-hidden="true" class="cover flex shrink-0 items-end rounded-md p-3 shadow-sm" style:background-color={`hsl(${(book.id * 67) % 360} 35% 82%)`} class:w-20={view === 'list'} class:h-24={view === 'list'} class:h-44={view === 'cards'}><span class="line-clamp-3 break-words text-sm font-semibold text-slate-800">{book.name}</span></div>
						<div class="min-w-0 flex-1"><h2 class="break-words font-semibold">{book.name}</h2>
							{#if showDescriptions && book.description}<p class="mt-1 line-clamp-2 break-words text-sm text-slate-500">{book.description}</p>{/if}
							{#if showSources}<p class="mt-2 text-xs text-slate-500">{m['wordbooks.book_count']({ count: book.book_count ?? involvedBookCount(cached[book.id] ?? []) })}</p>{/if}
							{#if book.archived}<span class="text-xs text-slate-500">{m['wordbooks.archived']()}</span>{/if}
						</div>
					</a>
				</li>
			{/each}
		</ul>
		{#if !loading && !visibleBooks.length && !error}<p class="text-slate-600">{m['wordbooks.no_matches']()}</p>{/if}
	{:else if !loading && !error}<p role="alert">{m['wordbooks.no_matches']()}</p>{/if}
</section>

<style>
	.cover { border-left: .4rem solid rgb(30 41 59 / .2); background-image: repeating-linear-gradient(0deg, transparent, transparent 19px, rgb(255 255 255 / .3) 20px); }
	.button { display: inline-block; min-height: 2.5rem; border: 1px solid #cbd5e1; border-radius: .375rem; padding: .5rem .75rem; background: white; font-size: .875rem; }
	.button:disabled { opacity: .5; cursor: not-allowed; }
	.button:focus-visible, .button:focus-within, .field:focus-visible, input:focus-visible { outline: 2px solid #0f172a; outline-offset: 2px; }
	.field { display: block; width: 100%; min-width: 0; border: 1px solid #94a3b8; border-radius: .375rem; padding: .5rem; background: white; }
	.action { text-decoration: underline; text-underline-offset: .2em; }
</style>
