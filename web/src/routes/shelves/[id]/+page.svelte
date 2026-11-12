<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import BookCard from '#lib/catalog/BookCard.svelte';
	import ViewToggle from '#lib/catalog/ViewToggle.svelte';
	import { rememberBrowseContext } from '#lib/bookview/browse-context.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import type { Book } from '#lib/catalog/types.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { translate } from '#lib/paging/translate.js';
	import { normalizeSearchInput, queryTooLong, searchBooks, searchErrorKey } from '#lib/search/api.js';
	import SearchResultCard from '#lib/search/SearchResultCard.svelte';
	import SearchField from '#lib/search/SearchField.svelte';
	import type { SearchResult } from '#lib/search/types.js';
	import {
		addBookToShelf,
		deleteShelf,
		getSessionViewer,
		getShelf,
		listShelfBooks,
		removeBookFromShelf,
		updateShelf
	} from '#lib/shelves/api.js';
	import { offersShelfManagement, shelfErrorKey, type ShelfFormValue } from '#lib/shelves/form.js';
	import ShelfDescription from '#lib/shelves/ShelfDescription.svelte';
	import ShelfForm from '#lib/shelves/ShelfForm.svelte';
	import type { SessionViewer, Shelf } from '#lib/shelves/types.js';
	import { libraryHref, shelfLibraryID } from '#lib/libraries/context.js';

	const books = new CursorPager<Book>();
	const candidates = new CursorPager<SearchResult>();
	let shelf = $state<Shelf | null>(null);
	let viewer = $state<SessionViewer | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let editing = $state(false);
	let deleting = $state(false);
	let notice = $state('');
	let actionError = $state('');
	let removing = $state<number | null>(null);
	let mode = $state<'grid' | 'list'>('grid');
	let addDraft = $state('');
	let addQuery = $state('');
	let addValidation = $state('');
	let adding = $state<number | null>(null);
	let addNotice = $state('');
	let addError = $state('');
	let requestVersion = 0;
	let libraryID = $state<number | undefined>(undefined);
	let metadataController: AbortController | null = null;

	const manageable = $derived(shelf !== null && offersShelfManagement(shelf, viewer));
	const editable = $derived(manageable && !shelf?.system_key);
	const membershipEditable = $derived(manageable && shelf?.mode !== 'automatic' && shelf?.system_key !== 'unshelved');

	$effect(() => {
		const id = page.params.id ?? '';
		const url = page.url;
		untrack(() => void loadShelf(id, shelfLibraryID(url)));
	});

	$effect(() => { if (shelf && books.status === 'ready') rememberBrowseContext({ ids: books.items.map((book) => book.id), label: shelf.name, href: libraryHref(`/shelves/${shelf.id}`, libraryID) }); });

	onDestroy(() => {
		requestVersion += 1;
		metadataController?.abort();
		books.dispose();
		candidates.dispose();
	});

	function parseID(value: string): number | null {
		if (!/^[1-9]\d*$/.test(value)) return null;
		const id = Number(value);
		return Number.isSafeInteger(id) ? id : null;
	}

	async function loadShelf(rawID: string, scope: number | undefined | null) {
		const request = ++requestVersion;
		metadataController?.abort();
		metadataController = new AbortController();
		const signal = metadataController.signal;
		libraryID = scope ?? undefined;
		shelf = null;
		loading = true;
		loadError = '';
		editing = false;
		notice = '';
		actionError = '';
		addNotice = '';
		addError = '';
		addQuery = '';
		addDraft = '';
		void candidates.reset(null);
		void books.reset(null);
		if (scope === null) {
			loadError = m['shelves.error.invalid']();
			loading = false;
			return;
		}
		const id = parseID(rawID);
		if (id === null) {
			loadError = m['shelves.error.not_found']();
			loading = false;
			return;
		}
		try {
			const [loaded, user] = await Promise.all([
				getShelf(id, { library_id: scope, signal }),
				viewer ? Promise.resolve(viewer) : getSessionViewer().catch(() => null)
			]);
			if (request !== requestVersion) return;
			shelf = loaded;
			viewer = user;
			void books.reset((cursor, signal) => listShelfBooks(id, { cursor, signal, library_id: scope }));
		} catch (cause) {
			if (request !== requestVersion) return;
			loadError = translate(shelfErrorKey(cause, 'load'));
		} finally {
			if (request === requestVersion) loading = false;
		}
	}

	/** Membership changed, so old cursors are stale: refresh the count and restart from page one. */
	async function refreshAfterMembershipChange(id: number) {
		const request = requestVersion;
		const scope = libraryID;
		void books.reload();
		try {
			const updated = await getShelf(id, { library_id: scope });
			if (request === requestVersion && shelf?.id === id) shelf = updated;
		} catch (cause) {
			console.error('Could not refresh shelf details', cause);
		}
	}

	async function save(value: ShelfFormValue): Promise<string | null> {
		if (!shelf) return null;
		notice = '';
		try {
			const id = shelf.id;
			const request = requestVersion;
			await updateShelf(id, { name: value.name, description: value.description });
			window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
			if (request !== requestVersion) return null;
			const updated = await getShelf(id, { library_id: libraryID });
			if (request !== requestVersion) return null;
			shelf = updated;
			editing = false;
			notice = m['shelves.edit.success']();
			return null;
		} catch (cause) {
			return translate(shelfErrorKey(cause, 'save'));
		}
	}

	async function remove() {
		if (!shelf || deleting) return;
		if (!window.confirm(m['shelves.delete.confirm']({ name: shelf.name }))) return;
		deleting = true;
		actionError = '';
		notice = '';
		try {
			await deleteShelf(shelf.id);
			window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
			await goto('/shelves');
		} catch (cause) {
			actionError = translate(shelfErrorKey(cause, 'delete'));
		} finally {
			deleting = false;
		}
	}

	async function removeBook(book: Book) {
		if (!shelf || removing !== null) return;
		const id = shelf.id;
		removing = book.id;
		actionError = '';
		notice = '';
		try {
			await removeBookFromShelf(id, book.id);
			window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
			notice = m['shelves.books.removed']();
			await refreshAfterMembershipChange(id);
		} catch (cause) {
			actionError = translate(shelfErrorKey(cause, 'remove_book'));
		} finally {
			removing = null;
		}
	}

	function findCandidates(event: SubmitEvent) {
		event.preventDefault();
		const query = normalizeSearchInput(addDraft);
		addNotice = '';
		addError = '';
		addValidation = queryTooLong(query) ? m['search.too_long']() : '';
		if (addValidation) return;
		if (query === addQuery && candidates.status !== 'error') return;
		addQuery = query;
		void candidates.reset(query ? (cursor, signal) => searchBooks(query, { cursor, signal }) : null);
	}

	function clearCandidates() {
		addDraft = '';
		addQuery = '';
		addNotice = '';
		addError = '';
		addValidation = '';
		void candidates.reset(null);
	}

	async function addBook(result: SearchResult) {
		if (!shelf || adding !== null) return;
		const id = shelf.id;
		adding = result.id;
		addNotice = '';
		addError = '';
		try {
			await addBookToShelf(id, result.id);
			window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
			addNotice = m['shelves.add.added']({ title: result.title });
			await refreshAfterMembershipChange(id);
		} catch (cause) {
			addError = translate(shelfErrorKey(cause, 'add_book'));
		} finally {
			adding = null;
		}
	}
</script>

<svelte:head>
	<title>{shelf ? `${shelf.name} · ` : ''}{m['shelves.title']()} · {m['common.app_name']()}</title>
</svelte:head>

{#if loadError}
	<div class="space-y-4" role="alert">
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{loadError}</p>
		<div class="flex flex-wrap gap-4">
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => loadShelf(page.params.id ?? '', shelfLibraryID(page.url))}>{m['shelves.retry']()}</button>
			<a class="underline underline-offset-4 focus-visible:outline-2" href="/shelves">{m['shelves.back']()}</a>
		</div>
	</div>
{:else if loading}
	<p class="text-slate-600" role="status">{m['shelves.loading']()}</p>
{:else if shelf}
	<article class="space-y-10" aria-labelledby="shelf-heading">
		<header class="space-y-3">
			<a class="text-sm text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2" href="/shelves">{m['shelves.back']()}</a>
			<h1 id="shelf-heading" class="sr-only">{shelf.name}</h1>
			<div class="flex flex-wrap items-center gap-3">
				<span class="rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-600">
					{shelf.kind === 'shared' ? m['shelves.kind.shared']() : m['shelves.kind.private']()}
				</span>
				<p class="text-sm text-slate-500">{m['shelves.book_count']({ count: shelf.visible_book_count })}</p>
			</div>
			{#if shelf.description}<ShelfDescription description={shelf.description} />{/if}
		</header>

		{#if notice}<p class="rounded-md bg-green-50 p-3 text-green-800" role="status">{notice}</p>{/if}
		{#if actionError}<p class="rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">{actionError}</p>{/if}

		{#if editable}
			<section class="space-y-4 card p-4 sm:p-6" aria-labelledby="edit-shelf-heading">
				<h2 id="edit-shelf-heading" class="text-xl font-semibold">{m['shelves.edit.heading']()}</h2>
				{#if editing}
					<ShelfForm
						idPrefix="edit-shelf"
						submitLabel={m['shelves.edit.save']()}
						busyLabel={m['shelves.edit.saving']()}
						initialName={shelf.name}
						initialDescription={shelf.description ?? ''}
						onsave={save}
						oncancel={() => (editing = false)}
					/>
				{:else}
					<div class="flex flex-wrap items-center gap-3">
						<button
							class="rounded-md border border-slate-300 px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
							onclick={() => (editing = true)}
						>{m['shelves.edit.open']()}</button>
						<button
							class="rounded-md border border-red-300 px-4 py-2 text-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-800 disabled:opacity-60"
							aria-describedby="delete-shelf-note"
							disabled={deleting}
							onclick={remove}
						>{deleting ? m['shelves.delete.deleting']() : m['shelves.delete.submit']()}</button>
					</div>
					<p id="delete-shelf-note" class="text-sm text-slate-600">{m['shelves.delete.note']()}</p>
				{/if}
			</section>
		{/if}

		<section class="space-y-5" aria-labelledby="shelf-books-heading" aria-busy={books.status === 'loading'}>
			<div class="flex flex-wrap items-end justify-between gap-4">
				<h2 id="shelf-books-heading" class="text-xl font-semibold">{m['shelves.books.heading']()}</h2>
				<ViewToggle view={mode} onchange={(next) => (mode = next)} />
			</div>
			{#if books.status === 'error'}
				<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
					<p>{translate(shelfErrorKey(books.error, 'load_books'))}</p>
					<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => books.retry()}>{m['shelves.retry']()}</button>
				</div>
			{:else if books.status !== 'ready'}
				<p class="text-slate-600" role="status">{m['shelves.books.loading']()}</p>
			{:else if books.empty}
				<p class="card p-6 text-slate-600">{m['shelves.books.empty']()}</p>
			{:else}
				<ul class={mode === 'grid' ? 'book-grid' : 'space-y-3'}>
					{#each books.items as book (book.id)}
						<BookCard {book} {mode}>
							{#snippet actions()}
								{#if membershipEditable}
									<button
										class={mode === 'grid'
											? 'inline-flex w-full items-center justify-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60'
											: 'text-sm text-red-800 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60'}
										aria-label={m['shelves.books.remove_label']({ title: book.title })}
										disabled={removing !== null}
										onclick={() => removeBook(book)}
									>
										{#if mode === 'grid'}<Icon name="trash" class="size-3.5 shrink-0" />{/if}
										<span class="min-w-0 truncate">{removing === book.id ? m['shelves.books.removing']() : m['shelves.books.remove']()}</span>
									</button>
								{/if}
							{/snippet}
						</BookCard>
					{/each}
				</ul>
				{#if books.moreError}
					<div class="flex flex-wrap items-center gap-3 text-red-800" role="alert">
						<p>{translate(shelfErrorKey(books.moreError, 'more_books'))}</p>
						{#if requestErrorKind(books.moreError) === 'invalid'}
							<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => books.reload()}>{m['shelves.books.restart']()}</button>
						{:else}
							<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => books.loadMore()}>{m['shelves.retry']()}</button>
						{/if}
					</div>
				{/if}
				{#if books.hasMore}
					<button
						class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
						disabled={books.loadingMore}
						onclick={() => books.loadMore()}
					>{books.loadingMore ? m['shelves.books.loading_more']() : m['shelves.books.load_more']()}</button>
				{:else}
					<p class="text-center text-sm text-slate-500" role="status">{m['shelves.books.end']()}</p>
				{/if}
			{/if}
		</section>

		{#if membershipEditable}
			<section class="space-y-4 card p-4 sm:p-6" aria-labelledby="add-books-heading">
				<h2 id="add-books-heading" class="text-xl font-semibold">{m['shelves.add.heading']()}</h2>
				<form role="search" aria-labelledby="add-books-heading" class="flex flex-wrap items-end gap-3" onsubmit={findCandidates} novalidate>
					<SearchField
						id="add-book-query"
						label={m['shelves.add.search_label']()}
						placeholder={m['search.placeholder']()}
						bind:value={addDraft}
						buttonLabel={m['shelves.add.submit']()}
						disabled={candidates.status === 'loading'}
						clear={addQuery !== '' && normalizeSearchInput(addDraft) === addQuery}
						onclear={clearCandidates}
					/>
				</form>
				{#if addValidation}<p class="text-sm text-red-700" role="alert">{addValidation}</p>{/if}
				{#if addNotice}<p class="text-sm text-green-700" role="status">{addNotice}</p>{/if}
				{#if addError}<p class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{addError}</p>{/if}
				{#if addQuery}
					{#if candidates.status === 'error'}
						<div class="flex flex-wrap items-center gap-3 text-red-800" role="alert">
							<p>{translate(searchErrorKey(candidates.error))}</p>
							{#if requestErrorKind(candidates.error) !== 'invalid'}
								<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => candidates.retry()}>{m['search.retry']()}</button>
							{/if}
						</div>
					{:else if candidates.status !== 'ready'}
						<p class="text-slate-600" role="status">{m['shelves.add.searching']()}</p>
					{:else if candidates.empty}
						<p class="text-slate-600" role="status">{m['shelves.add.no_results']()}</p>
					{:else}
						<ul class="space-y-3">
							{#each candidates.items as result (result.id)}
								<SearchResultCard {result}>
									{#snippet actions()}
										<button
											class="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
											aria-label={m['shelves.add.add_label']({ title: result.title })}
											disabled={adding !== null}
											onclick={() => addBook(result)}
										>{adding === result.id ? m['shelves.add.adding']() : m['shelves.add.add']()}</button>
									{/snippet}
								</SearchResultCard>
							{/each}
						</ul>
						{#if candidates.moreError}
							<div class="flex flex-wrap items-center gap-3 text-red-800" role="alert">
								<p>{translate(searchErrorKey(candidates.moreError))}</p>
								<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => (requestErrorKind(candidates.moreError) === 'invalid' ? candidates.reload() : candidates.loadMore())}>
									{requestErrorKind(candidates.moreError) === 'invalid' ? m['search.restart']() : m['search.retry']()}
								</button>
							</div>
						{/if}
						{#if candidates.hasMore}
							<button
								class="rounded-md border border-slate-300 px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
								disabled={candidates.loadingMore}
								onclick={() => candidates.loadMore()}
							>{candidates.loadingMore ? m['search.loading_more']() : m['shelves.add.more']()}</button>
						{/if}
					{/if}
				{/if}
			</section>
		{/if}
	</article>
{/if}
