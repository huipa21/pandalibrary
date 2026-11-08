<script lang="ts">
	import { getLibrary } from '#lib/catalog/api.js';
	import type { Book, BookFile } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import { offlineStatus } from '#lib/sync/client.js';
	import Icon from '../Icon.svelte';
	import { getBookContext } from '../book-context.svelte.js';
	import { formatDate, formatSize } from '../format.js';
	import { saveUserBook, type UserBook } from '../user-book.js';

	let { book, primaryFile, userBook, ready, offline, canEdit }: {
		book: Book;
		primaryFile: BookFile | null;
		userBook: UserBook | null;
		ready: boolean;
		offline: boolean;
		canEdit?: boolean;
	} = $props();

	const context = getBookContext();
	type DateField = 'started_at' | 'finished_at';
	const dateFields: readonly DateField[] = ['started_at', 'finished_at'];
	const libraryCache = new Map<number, string>();
	let libraryName = $state<string | null>(null);
	let libraryError = $state('');
	let editing = $state<DateField | null>(null);
	let dateValue = $state('');
	let dateBusy = $state(false);
	let dateError = $state('');
	const isbn = $derived(book.identifiers.find((item) =>
		['isbn', 'isbn10', 'isbn13'].includes(item.scheme.trim().toLowerCase())
	)?.value ?? null);
	const metadataSources = $derived([...new Set(book.field_sources.map((item) => item.source))]);

	$effect(() => {
		book.id;
		editing = null;
		dateError = '';
	});

	$effect(() => {
		const id = book.library_id;
		const isOffline = offline;
		let active = true;
		const cached = libraryCache.get(id) ?? null;
		libraryError = '';
		libraryName = cached;
		if (!cached && !isOffline) {
			void getLibrary(id).then(
				(library) => {
					if (!active) return;
					libraryCache.set(id, library.name);
					libraryName = library.name;
				},
				(cause: unknown) => {
					if (!active) return;
					console.error('Could not load the book library', cause);
					libraryError = m['bv6.library_error']();
				}
			);
		}
		return () => { active = false; };
	});

	function dateLabel(field: DateField): string {
		return field === 'started_at' ? m['bv6.started']() : m['bv6.finished']();
	}

	function editDate(field: DateField) {
		dateValue = userBook?.[field]?.slice(0, 10) ?? '';
		dateError = '';
		editing = field;
	}

	async function saveDate(field: DateField, value: string | null) {
		if (dateBusy || !ready || offline) return;
		const id = book.id;
		dateBusy = true;
		dateError = '';
		try {
			await saveUserBook(id, userBook, field === 'started_at' ? { started_at: value } : { finished_at: value });
			if (book.id === id) editing = null;
		} catch (cause) {
			console.error('Could not save the reading date', cause);
			if (book.id === id) dateError = m['bv6.date_error']();
		} finally {
			dateBusy = false;
		}
	}
</script>

<section class="min-w-0 space-y-4 card p-5" aria-labelledby="book-details-heading">
	<div class="flex items-center justify-between">
		<h2 id="book-details-heading" class="text-xs font-semibold tracking-wider text-slate-500 uppercase">{m['bv6.details']()}</h2>
		{#if (canEdit ?? context.canEditMetadata) && !offline && $offlineStatus.online}
			<a
				class="inline-flex size-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
				href={`/books/${book.id}/edit`}
				aria-label={m['bd6.edit_metadata']()}
				title={m['bd6.edit_metadata']()}
			><Icon name="pencil" class="size-4" /></a>
		{/if}
	</div>
	<dl class="space-y-3 text-sm">
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['catalog.book.publisher']()}</dt><dd class="text-slate-800 [overflow-wrap:anywhere]">{book.publisher || '–'}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['catalog.book.published']()}</dt><dd class="text-slate-800 [overflow-wrap:anywhere]">{book.published_date || '–'}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['catalog.book.language']()}</dt><dd class="text-slate-800 [overflow-wrap:anywhere]">{book.language || '–'}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['catalog.book.page_count']()}</dt><dd class="text-slate-800">{book.page_count ?? '–'}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['bv6.isbn']()}</dt><dd class="text-slate-800 [overflow-wrap:anywhere]">{isbn || '–'}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['bv6.file_size']()}</dt><dd class="text-slate-800">{primaryFile ? formatSize(primaryFile.size_bytes) : '–'}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
			<dt class="text-slate-500">{m['bv6.library']()}</dt>
			<dd class="text-slate-800 [overflow-wrap:anywhere]">
				{#if libraryError}<span class="text-red-800" role="alert">{libraryError}</span>
				{:else if libraryName && !offline}<a class="text-emerald-800 underline-offset-4 hover:underline" href={`/library/${book.library_id}`}>{libraryName}</a>
				{:else}{libraryName || '–'}{/if}
			</dd>
		</div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['bv6.added']()}</dt><dd class="text-slate-800">{formatDate(book.created_at)}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
			<dt class="text-slate-500">{m['bd6.metadata_source']()}</dt>
			<dd class="text-slate-800 [overflow-wrap:anywhere]">
				<span>{metadataSources.length ? metadataSources.join(', ') : '–'}</span>
				{#if metadataSources.length}
					<details class="mt-1 text-xs text-slate-600">
						<summary class="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-emerald-700">{m['bd6.show_fields']()}</summary>
						<ul class="mt-2 space-y-1">
							{#each book.field_sources as source}
								<li>{source.field}: {source.source}{#if source.source_ref}{' · '}{source.source_ref}{/if}</li>
							{/each}
						</ul>
					</details>
				{/if}
			</dd>
		</div>
		{#if book.cover_source}
			<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['bd6.cover_source']()}</dt><dd class="text-slate-800 [overflow-wrap:anywhere]">{book.cover_source}</dd></div>
		{/if}
		{#each dateFields as field}
			<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
				<dt class="text-slate-500">{dateLabel(field)}</dt>
				<dd class="min-w-0 text-slate-800">
					{#if editing === field}
						<form class="space-y-2" onsubmit={(event) => { event.preventDefault(); void saveDate(field, dateValue || null); }}>
							<input class="max-w-full rounded-md border border-slate-300 px-2 py-1" type="date" aria-label={dateLabel(field)} bind:value={dateValue} disabled={dateBusy} />
							<div class="flex flex-wrap gap-2 text-xs">
								<button type="submit" class="font-semibold text-emerald-800 underline" disabled={dateBusy}>{dateBusy ? m['bv6.saving']() : m['bv6.save']()}</button>
								<button type="button" class="font-medium text-slate-600 underline" disabled={dateBusy} onclick={() => void saveDate(field, null)}>{m['bv6.clear']()}</button>
								<button type="button" class="font-medium text-slate-600 underline" disabled={dateBusy} onclick={() => (editing = null)}>{m['bv6.cancel']()}</button>
							</div>
						</form>
					{:else}
						<span>{userBook?.[field] ? formatDate(userBook[field].slice(0, 10)) : '–'}</span>
						{#if ready && !offline}
							<button type="button" class="ml-1 inline-flex rounded p-1 text-slate-500 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-emerald-700" aria-label={m['bv6.edit_date']({ label: dateLabel(field) })} onclick={() => editDate(field)}><Icon name="pencil" class="size-4" /></button>
						{/if}
					{/if}
				</dd>
			</div>
		{/each}
	</dl>
	{#if dateError}<p class="text-sm text-red-800" role="alert">{dateError}</p>{/if}
</section>
