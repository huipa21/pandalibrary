<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { wordbooks, type Wordbook, type WordbookEntry } from '#lib/wordbooks/api.js';
	import Entry from '#lib/wordbooks/Entry.svelte';
	import { downloadWordbook, readPreferences, sortEntries, writePreferences, type EntrySort, type EntryView } from '#lib/wordbooks/management.js';

	let books = $state<Wordbook[]>([]);
	let selectedId = $state<number | null>(null);
	let entries = $state<WordbookEntry[]>([]);
	let showArchived = $state(false);
	let loading = $state(true);
	let entriesLoading = $state(false);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let view = $state<EntryView>('list');
	let sort = $state<EntrySort>('chronological');
	let nameMode = $state<'new' | 'rename' | null>(null);
	let name = $state('');
	let request = 0;
	let disposed = false;
	const visibleBooks = $derived(books.filter((book) => showArchived || !book.archived));
	const selected = $derived(books.find((book) => book.id === selectedId));
	const sorted = $derived(sortEntries(entries, sort));

	onMount(() => {
		void initialize();
		return () => { disposed = true; request++; };
	});

	function showError(cause: unknown) {
		error = cause instanceof Error ? cause.message : String(cause);
	}
	async function initialize() {
		loading = true;
		error = '';
		try {
			const result = await wordbooks.list();
			if (disposed) return;
			books = result;
			const first = result.find((book) => book.is_default && !book.archived) ?? result.find((book) => !book.archived);
			if (first) await selectBook(first.id);
		} catch (cause) { if (!disposed) showError(cause); }
		finally { if (!disposed) loading = false; }
	}
	async function loadEntries(id: number) {
		const token = ++request;
		entriesLoading = true;
		try {
			const result = await wordbooks.entries(id);
			if (token === request && !disposed) entries = result;
		} finally {
			if (token === request && !disposed) entriesLoading = false;
		}
	}
	async function selectBook(id: number) {
		selectedId = id;
		entries = [];
		error = '';
		notice = '';
		nameMode = null;
		({ view, sort } = readPreferences(id));
		try { await loadEntries(id); }
		catch (cause) { if (selectedId === id && !disposed) showError(cause); }
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
		if (selectedId !== null) writePreferences(selectedId, { view, sort });
	}
	function beginName(mode: 'new' | 'rename') {
		nameMode = mode;
		name = mode === 'rename' ? selected?.name ?? '' : '';
	}
	async function saveName(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim()) return;
		const mode = nameMode;
		const id = selectedId;
		await operate(async () => {
			if (mode === 'new') {
				const book = await wordbooks.create(name.trim());
				books = [...books, book];
				await selectBook(book.id);
			} else if (mode === 'rename' && id !== null) {
				const book = await wordbooks.update(id, { name: name.trim() });
				books = books.map((item) => item.id === id ? book : item);
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
			if (updated.archived && !showArchived) {
				const next = books.find((item) => !item.archived);
				if (next) await selectBook(next.id);
				else { selectedId = null; entries = []; request++; }
			}
		});
	}
	function toggleArchived() {
		showArchived = !showArchived;
		if (!showArchived && selected?.archived) {
			const next = books.find((item) => !item.archived);
			if (next) void selectBook(next.id);
			else { selectedId = null; entries = []; request++; }
		}
	}
	async function saveEntry(id: number, changes: { text: string; definition?: string; note?: string }) {
		const bookId = selectedId;
		if (bookId === null) return false;
		return operate(async () => {
			const updated = await wordbooks.edit(bookId, id, changes);
			entries = entries.map((item) => item.id === id ? updated : item);
		});
	}
	async function deleteEntry(id: number) {
		const bookId = selectedId;
		if (bookId === null) return;
		await operate(async () => {
			await wordbooks.remove(bookId, id);
			entries = entries.filter((item) => item.id !== id);
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
		if (!file || id === null) return;
		await operate(async () => {
			// The server validates the JSON schema and reports precise import failures.
			const result = await wordbooks.import(id, file);
			notice = m['wordbooks.imported']({ count: result.imported });
			await loadEntries(id);
		});
	}
</script>

<svelte:head><title>{m['wordbooks.title']()} · {m['common.app_name']()}</title></svelte:head>

<section class="space-y-6" aria-labelledby="wordbooks-heading" aria-busy={busy || loading}>
	<div class="flex flex-wrap items-center justify-between gap-3">
		<h1 id="wordbooks-heading" class="text-2xl font-semibold">{m['wordbooks.title']()}</h1>
		<button class="button" disabled={busy || loading} onclick={() => beginName('new')}>{m['wordbooks.new']()}</button>
	</div>
	{#if error}<p role="alert" class="break-words rounded-md border border-red-200 bg-red-50 p-3 text-red-800">{error}</p>{/if}
	{#if notice}<p role="status" class="text-sm text-green-800">{notice}</p>{/if}
	{#if loading}<p role="status">{m['wordbooks.loading']()}</p>{/if}
	<div class="flex flex-wrap items-end gap-4">
		<label class="min-w-0 flex-1 space-y-1 sm:max-w-sm">
			<span class="block text-sm font-medium">{m['wordbooks.name']()}</span>
			<select class="field" value={selectedId ?? ''} disabled={busy || loading} onchange={(event) => void selectBook(Number(event.currentTarget.value))}>
				{#each visibleBooks as book}
					<option value={book.id}>{book.name}{book.is_default ? ` · ${m['wordbooks.default']()}` : ''}{book.archived ? ` · ${m['wordbooks.archived']()}` : ''}</option>
				{/each}
			</select>
		</label>
		<label class="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={showArchived} disabled={busy || loading} onchange={toggleArchived} />{m['wordbooks.show_archived']()}</label>
	</div>
	{#if nameMode}
		<form class="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 p-4" onsubmit={saveName} aria-label={nameMode === 'new' ? m['wordbooks.new']() : m['wordbooks.rename']()}>
			<label class="min-w-0 flex-1 space-y-1"><span class="block text-sm font-medium">{m['wordbooks.name']()}</span><input class="field" required maxlength="200" bind:value={name} disabled={busy} /></label>
			<button class="button" type="submit" disabled={busy || !name.trim()}>{nameMode === 'new' ? m['wordbooks.create']() : m['wordbooks.save']()}</button>
			<button class="button" type="button" disabled={busy} onclick={() => nameMode = null}>{m['wordbooks.cancel']()}</button>
		</form>
	{/if}
	{#if selected}
		<div class="flex flex-wrap items-center gap-3">
			<h2 class="mr-auto text-xl font-semibold">{selected.name}</h2>
			{#if selected.archived}<span class="text-sm text-slate-600">{m['wordbooks.archived']()}</span>{/if}
			<button class="button" disabled={busy} onclick={() => beginName('rename')}>{m['wordbooks.rename']()}</button>
			{#if !selected.is_default}<button class="button" disabled={busy} onclick={archive}>{selected.archived ? m['wordbooks.unarchive']() : m['wordbooks.archive']()}</button>{/if}
			<button class="button" disabled={busy} onclick={exportBook}>{m['wordbooks.export']()}</button>
			<label class="button relative cursor-pointer" class:opacity-50={busy || selected.archived}>
				{m['wordbooks.import']()}
				<input class="absolute inset-0 w-full cursor-pointer opacity-0" type="file" accept=".json,application/json" aria-label={m['wordbooks.import']()} disabled={busy || selected.archived} onchange={importBook} />
			</label>
		</div>
		<div class="flex flex-wrap items-center gap-3">
			<div class="flex gap-1">
				<button class="button" aria-pressed={view === 'list'} onclick={() => changePreferences('list', sort)}>{m['wordbooks.list']()}</button>
				<button class="button" aria-pressed={view === 'cards'} onclick={() => changePreferences('cards', sort)}>{m['wordbooks.cards']()}</button>
			</div>
			<label class="flex items-center gap-2 text-sm"><span>{m['wordbooks.sort']()}</span><select class="field" value={sort} onchange={(event) => changePreferences(view, event.currentTarget.value as EntrySort)}>
				<option value="chronological">{m['wordbooks.chronological']()}</option>
				<option value="alphabetical">{m['wordbooks.alphabetical']()}</option>
			</select></label>
		</div>
		{#if entriesLoading}<p role="status">{m['wordbooks.loading']()}</p>
		{:else if !entries.length && !error}<p class="text-slate-600">{m['wordbooks.empty']()}</p>
		{:else}
			<ol data-view={view} aria-label={selected.name} class={view === 'cards' ? 'grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3' : 'divide-y divide-slate-200'}>
				{#each sorted as entry (entry.id)}
					<li data-entry-id={entry.id} class={view === 'cards' ? 'min-w-0 rounded-lg border border-slate-200 p-4' : 'min-w-0 py-5'}>
						<Entry {entry} disabled={busy} onsave={saveEntry} ondelete={deleteEntry} />
					</li>
				{/each}
			</ol>
		{/if}
	{/if}
</section>

<style>
	.button { display: inline-block; min-height: 2.5rem; border: 1px solid #cbd5e1; border-radius: .375rem; padding: .5rem .75rem; background: white; font-size: .875rem; }
	.button[aria-pressed='true'] { background: #e2e8f0; border-color: #475569; }
	.button:disabled { opacity: .5; cursor: not-allowed; }
	.button:focus-visible, .button:focus-within, .field:focus-visible, input:focus-visible { outline: 2px solid #0f172a; outline-offset: 2px; }
	.field { display: block; width: 100%; min-width: 0; border: 1px solid #94a3b8; border-radius: .375rem; padding: .5rem; background: white; }
</style>
