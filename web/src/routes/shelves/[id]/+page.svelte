<script lang="ts">
	import { confirmAction } from '#lib/shell/confirmation.js';
	import { onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import BookBrowser from '#lib/catalog/BookBrowser.svelte';
	import Icon from '#lib/bookview/Icon.svelte';
	import type { PageOptions } from '#lib/catalog/api.js';
	import type { BookFilters, BookSort } from '#lib/catalog/types.js';
	import { translate } from '#lib/paging/translate.js';
	import {
		collectionLibraryID,
		deleteShelf,
		getSessionViewer,
		getShelf,
		listShelfBooks,
		updateShelf
	} from '#lib/shelves/api.js';
	import { offersShelfManagement, shelfErrorKey, type ShelfFormValue } from '#lib/shelves/form.js';
	import ShelfForm from '#lib/shelves/ShelfForm.svelte';
	import { shelfRuleGroups } from '#lib/shelves/rules.js';
	import type { SessionViewer, Shelf } from '#lib/shelves/types.js';

	let shelf = $state<Shelf | null>(null);
	let viewer = $state<SessionViewer | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let deleting = $state(false);
	let notice = $state('');
	let actionError = $state('');
	let requestVersion = 0;
	let libraryID = $state<number | undefined>(undefined);
	let metadataController: AbortController | null = null;
	const manageable = $derived(shelf !== null && offersShelfManagement(shelf, viewer));
	const editable = $derived(manageable && !shelf?.system_key);
	const initialRuleGroups = $derived(shelf ? shelfRuleGroups(shelf, m['ux3.shelves.rules_label']()) : []);
	const currentID = $derived(page.params.id ?? '');
	const libraryScope = $derived(collectionLibraryID(page.url));
	const browseScope = $derived({ library_id: libraryID });
	const managing = $derived(page.url.searchParams.get('manage') === '1');

	$effect(() => {
		const id = currentID;
		const scope = libraryScope;
		untrack(() => void loadShelf(id, scope));
	});

	onDestroy(() => {
		requestVersion += 1;
		metadataController?.abort();
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
		notice = '';
		actionError = '';
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
		} catch (cause) {
			if (request !== requestVersion) return;
			loadError = translate(shelfErrorKey(cause, 'load'));
		} finally {
			if (request === requestVersion) loading = false;
		}
	}

	function fetchBooks(filters: BookFilters, sort: BookSort, options: PageOptions = {}) {
		if (!shelf) throw new Error('The collection is unavailable.');
		return listShelfBooks(shelf.id, { ...filters, ...options, sort });
	}

	function bookErrorMessage(cause: unknown, more: boolean): string {
		return translate(shelfErrorKey(cause, more ? 'more_books' : 'load_books'));
	}

	async function save(value: ShelfFormValue): Promise<string | null> {
		if (!shelf || !editable) return null;
		notice = '';
		try {
			const id = shelf.id;
			const request = requestVersion;
			await updateShelf(id, {
				name: value.name, description: value.description,
				...(value.icon !== (shelf.icon ?? '') ? { icon: value.icon } : {}),
				rule_groups: value.rule_groups, remove_rule_books: value.remove_rule_books
			});
			window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
			if (request !== requestVersion) return null;
			const updated = await getShelf(id, { library_id: libraryID });
			if (request !== requestVersion) return null;
			shelf = updated;
			notice = m['shelves.edit.success']();
			return null;
		} catch (cause) {
			return translate(shelfErrorKey(cause, 'save'));
		}
	}

	async function remove() {
		if (!shelf || deleting) return;
		if (!await confirmAction(m['shelves.delete.confirm']({ name: shelf.name }))) return;
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

</script>

<svelte:head>
	<title>{shelf ? `${shelf.name} · ` : ''}{m['shelves.title']()} · {m['common.app_name']()}</title>
</svelte:head>

{#if loadError}
	<div class="space-y-4" role="alert">
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{loadError}</p>
		<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => loadShelf(page.params.id ?? '', collectionLibraryID(page.url))}>{m['shelves.retry']()}</button>
	</div>
{:else if loading}
	<p class="text-slate-600" role="status">{m['shelves.loading']()}</p>
{:else if shelf}
	{#if managing}
		<section class="card space-y-4 p-6" aria-labelledby="edit-shelf-heading">
			<header class="flex items-center justify-between gap-4">
				<h1 id="edit-shelf-heading" class="text-xl font-semibold">{m['collections.settings.heading']()}</h1>
				<a class="shell-icon-button" href="/shelves" aria-label={m['shelves.back']()} title={m['shelves.back']()}>
					<Icon name="arrow-left" />
				</a>
			</header>
			{#if notice}<p class="rounded-md bg-green-50 p-3 text-green-800" role="status">{notice}</p>{/if}
			{#if actionError}<p class="rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">{actionError}</p>{/if}
			{#if !editable}<p class="text-sm text-slate-600">{m['collections.settings.readonly']()}</p>{/if}
			<ShelfForm
				idPrefix="edit-shelf"
				submitLabel={m['shelves.edit.save']()}
				busyLabel={m['shelves.edit.saving']()}
				initialName={shelf.name}
				initialIcon={shelf.icon ?? ''}
				initialDescription={shelf.description ?? ''}
				readOnly={!editable}
				{initialRuleGroups}
				onsave={save}
			/>
			{#if editable}
				<div class="flex flex-wrap items-center gap-3">
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
	{:else}
		<article aria-labelledby="shelf-heading">
			<h1 id="shelf-heading" class="sr-only">{shelf.name}</h1>
			{#if notice}<p class="mb-4 rounded-md bg-green-50 p-3 text-green-800" role="status">{notice}</p>{/if}
			{#if actionError}<p class="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">{actionError}</p>{/if}
			<BookBrowser scope={browseScope} showHeading={false} {fetchBooks} {bookErrorMessage} />
		</article>
	{/if}
{/if}
