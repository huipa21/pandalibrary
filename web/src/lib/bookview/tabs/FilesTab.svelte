<script lang="ts">
	import { ApiError } from '#lib/api/client.js';
	import { getLibrary } from '#lib/catalog/api.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getBookState } from '#lib/reader/api.js';
	import type { Progress } from '#lib/reader/types.js';
	import { currentAccount, offlineStatus } from '#lib/sync/client.js';
	import { downloadedBooks, OfflineStorageError, removeBook } from '#lib/sync/db.js';
	import { downloadForOffline } from '#lib/sync/library.js';
	import { readerState } from '#lib/sync/state.js';
	import { getBookContext } from '../book-context.svelte.js';
	import { BOOK_STATE_CHANGED_EVENT, type BookStateChangedDetail } from '../events.js';
	import FileGroupList from '../files/FileGroupList.svelte';
	import FilePanel from '../files/FilePanel.svelte';
	import FilesSummary from '../files/FilesSummary.svelte';
	import { buildFilesModel, type FileItem, type FileSort } from '../files/files-model.js';
	import { setDefaultFile } from '../files/files-api.js';
	import AddFileButton from '../files/AddFileButton.svelte';
	import BookShelfTags from '../details/BookShelfTags.svelte';
	import { createBookShelves } from '../details/book-shelves.svelte.js';
	import ShelfPopover from '../quickview/ShelfPopover.svelte';

	const context = getBookContext();
	const book = $derived(context.book);
	const online = $derived(!context.offline && $offlineStatus.online);
	const shelves = createBookShelves(() => book?.id ?? null);
	let progress = $state<Progress | null>(null);
	let progressError = $state('');
	let libraryName = $state('');
	let libraryError = $state('');
	let selectedFileId = $state<number | null>(null);
	let selectionChanged = $state(false);
	let sort = $state<FileSort>('format');
	let busyFileId = $state<number | null>(null);
	let busyAction = $state<'save' | 'remove' | null>(null);
	let defaultBusy = $state(false);
	let notice = $state('');
	let actionError = $state('');
	let activeBookId: number | null = null;
	let progressVersion = 0;
	let libraryVersion = 0;
	let reconnectRequested = false;
	let wasSyncing = false;

	const model = $derived(book ? buildFilesModel(book, progress, context.savedFileIds) : null);
	const selected = $derived(model?.groups.flatMap((group) => group.files).find((file) => file.id === selectedFileId) ?? null);

	$effect(() => {
		const id = book?.id ?? null;
		if (id === activeBookId) return;
		activeBookId = id;
		progress = null;
		progressError = '';
		selectedFileId = null;
		selectionChanged = false;
		reconnectRequested = false;
		notice = '';
		actionError = '';
	});

	$effect(() => {
		const current = model;
		if (!current) return;
		const exists = current.groups.some((group) => group.files.some((file) => file.id === selectedFileId));
		if (!exists) selectionChanged = false;
		if (!selectionChanged) selectedFileId = current.primaryFileId;
	});

	async function loadProgress(id: number, useOffline: boolean) {
		const request = ++progressVersion;
		try {
			const state = useOffline
				? (await readerState(currentAccount(), id)).state
				: await getBookState(id);
			if (request !== progressVersion || context.book?.id !== id) return;
			progress = state.progress;
			progressError = '';
		} catch (cause) {
			if (request !== progressVersion || context.book?.id !== id) return;
			console.error('Could not load reading progress for the files tab', cause);
			progress = null;
			progressError = m['bv7.progress_failure']();
		}
	}

	$effect(() => {
		const connected = $offlineStatus.online;
		const loadedOffline = context.offline;
		const id = book?.id;
		if (!connected) reconnectRequested = false;
		else if (id && loadedOffline && !reconnectRequested) {
			reconnectRequested = true;
			void context.reload();
		}
	});

	$effect(() => {
		const id = book?.id;
		const useOffline = !online;
		if (!id) return;
		void loadProgress(id, useOffline);
		const refresh = (event: Event) => {
			const detail = (event as CustomEvent<BookStateChangedDetail | null>).detail;
			if (detail?.bookId === id) void loadProgress(id, useOffline);
		};
		window.addEventListener(BOOK_STATE_CHANGED_EVENT, refresh);
		return () => {
			progressVersion += 1;
			window.removeEventListener(BOOK_STATE_CHANGED_EVENT, refresh);
		};
	});

	$effect(() => {
		const syncing = $offlineStatus.syncing;
		const connected = online;
		const id = book?.id;
		const completed = wasSyncing && !syncing;
		wasSyncing = syncing;
		if (completed && id && connected) void loadProgress(id, false);
	});

	$effect(() => {
		const id = book?.library_id;
		const connected = online;
		const request = ++libraryVersion;
		libraryError = '';
		libraryName = id ? m['bv7.library_fallback']({ id: String(id) }) : '';
		if (!id || !connected) return;
		void getLibrary(id).then(
			(library) => {
				if (request === libraryVersion) libraryName = library.name;
			},
			(cause) => {
				if (request !== libraryVersion) return;
				console.error('Could not load the library name for the files tab', cause);
				libraryError = m['bv7.library_failure']();
			}
		);
		return () => { libraryVersion += 1; };
	});

	function chooseFile(id: number) {
		selectedFileId = id;
		selectionChanged = true;
	}

	async function saveOffline(file: FileItem) {
		if (!book || busyAction !== null) return;
		const currentBook = $state.snapshot(book);
		const id = currentBook.id;
		busyFileId = file.id;
		busyAction = 'save';
		notice = '';
		actionError = '';
		try {
			const currentFile = currentBook.files.find((item) => item.id === file.id);
			if (!currentFile) throw new OfflineStorageError('The selected book file is missing.');
			await downloadForOffline(currentAccount(), currentBook, currentFile);
			const stored = (await downloadedBooks(currentAccount())).find((item) => item.book.id === id);
			if (context.book?.id !== id) return;
			context.savedFileIds = stored?.fileIds ?? [];
			notice = m['offline.download_success']();
		} catch (cause) {
			console.error('Could not download the book for offline reading', cause);
			if (context.book?.id !== id) return;
			actionError = m['offline.download_failure']();
			if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) {
				context.savedFileIds = [];
			}
		} finally {
			busyFileId = null;
			busyAction = null;
		}
	}

	async function removeOffline(file: FileItem) {
		if (!book || busyAction !== null || !window.confirm(m['offline.storage.remove_confirm']())) return;
		const id = book.id;
		const loadedOffline = context.offline;
		busyFileId = file.id;
		busyAction = 'remove';
		notice = '';
		actionError = '';
		try {
			await removeBook(currentAccount(), id);
			if (context.book?.id !== id) return;
			context.savedFileIds = [];
			notice = m['offline.storage.removed']();
			if (loadedOffline) await context.reload();
		} catch (cause) {
			console.error('Could not remove the downloaded book', cause);
			if (context.book?.id === id) actionError = m['offline.storage.failure']();
		} finally {
			busyFileId = null;
			busyAction = null;
		}
	}

	async function toggleDefault(file: FileItem) {
		if (!book || defaultBusy || !online) return;
		const id = book.id;
		defaultBusy = true;
		notice = '';
		actionError = '';
		try {
			const updated = await setDefaultFile(id, file.is_default ? null : file.id);
			if (context.book?.id !== id) return;
			context.book = updated;
			notice = file.is_default ? m['bv8.default_cleared']() : m['bv8.default_set']({ name: file.original_filename });
		} catch (cause) {
			console.error('Could not change the default file', cause);
			if (context.book?.id === id) actionError = m['bv8.default_failure']();
		} finally {
			defaultBusy = false;
		}
	}

	async function copyName(file: FileItem) {
		notice = '';
		actionError = '';
		try {
			if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
			await navigator.clipboard.writeText(file.original_filename);
			notice = m['bv7.copy_success']();
		} catch (cause) {
			console.error('Could not copy the file name', cause);
			actionError = m['bv7.copy_failure']();
		}
	}
</script>

{#if book && model}
	<div class="min-w-0 space-y-4">
		<FilesSummary {book} coverSource={context.coverSource} {libraryName} {model} {online} bind:sort />
		<div class="card flex min-w-0 flex-wrap items-center justify-between gap-4 p-4">
			<div class="flex min-w-0 flex-1 items-center gap-3">
				{#if online || shelves.status !== 'error'}
					<BookShelfTags {shelves} bookTitle={book.title} offline={!online} />
				{/if}
				{#if online}<ShelfPopover bookId={book.id} variant="plain-icon" placement="down" memberIds={shelves.memberIds} />{/if}
			</div>
			{#if context.canEditMetadata}
				{#key book.id}
					<AddFileButton {book} offline={!online} onAdded={() => context.reload()} />
				{/key}
			{/if}
		</div>
		{#if libraryError}<p role="alert" class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{libraryError}</p>{/if}
		{#if progressError}
			<div role="alert" class="flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
				<span>{progressError}</span>
				<button class="font-medium underline focus-visible:outline-2" onclick={() => loadProgress(book.id, !online)}>{m['catalog.retry']()}</button>
			</div>
		{/if}
		{#if notice}<p role="status" class="rounded-lg bg-green-50 p-3 text-sm text-green-800">{notice}</p>{/if}
		{#if actionError}<p role="alert" class="rounded-lg bg-red-50 p-3 text-sm text-red-800">{actionError}</p>{/if}
		{#if busyFileId !== null}
			<p role="status" class="text-sm text-slate-600">{busyAction === 'save' ? m['offline.downloading']() : m['bv7.removing_offline']()}</p>
		{/if}
		{#if model.groups.length}
			<div class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
				<FileGroupList
					bookId={book.id} groups={model.groups} {sort} {selectedFileId} {online}
					offlineAvailable={$offlineStatus.available} busy={busyAction !== null}
					onChoose={chooseFile} onSave={saveOffline} onRemove={removeOffline} onCopy={copyName}
				/>
				{#if selected}
					<FilePanel
						bookId={book.id} file={selected} primary={selected.id === model.primaryFileId}
						progressUpdatedAt={selected.progress !== null ? progress?.updated_at ?? null : null}
						{online} offlineAvailable={$offlineStatus.available} busy={busyAction !== null}
						onSave={saveOffline} onRemove={removeOffline} onCopy={copyName}
						canSetDefault={context.canEditMetadata && !context.offline} {defaultBusy} onToggleDefault={toggleDefault}
					/>
				{/if}
			</div>
		{:else}
			<section class="card p-6 text-slate-600" aria-labelledby="files-empty-heading">
				<h2 id="files-empty-heading" class="font-semibold text-slate-900">{m['bv7.empty_title']()}</h2>
				<p class="mt-2">{m['bv7.empty_description']()}</p>
			</section>
		{/if}
	</div>
{/if}
