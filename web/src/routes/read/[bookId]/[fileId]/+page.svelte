<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { v7 as uuidv7 } from 'uuid';
	import * as m from '#lib/paraglide/messages.js';
	import { ApiError, type JsonValue } from '#lib/api/client.js';
	import { getBook } from '#lib/catalog/api.js';
	import type { Book, BookFile } from '#lib/catalog/types.js';
	import { createReader, readerFormat } from '#lib/reader/index.js';
	import { deviceId, downloadBookFile, getBookState, getSettings, SyncError } from '#lib/reader/api.js';
	import { annotationForReader, deleteAnnotation, highlightColor, HIGHLIGHT_COLORS, makeHighlight, makeNote, type HighlightColor } from '#lib/reader/annotations.js';
	import { bookmarkForPosition, deleteBookmark, makeBookmark, updateBookmarkLabel } from '#lib/reader/bookmarks.js';
	import { renderMarkdown } from '#lib/reader/markdown.js';
	import { fraction, progressMutation, restorePosition } from '#lib/reader/progress.js';
	import { ReadingSessions, SessionWriter } from '#lib/reader/sessions.js';
	import { DEFAULT_SETTINGS, isReaderSettings, loadReaderSettings, mergeBookSettings } from '#lib/reader/settings.js';
	import type { Bookmark, Highlight, Note, Reader, ReaderFormat, ReaderSelection, ReaderSettings, Relocation } from '#lib/reader/types.js';
	import NoteEditor from '#lib/reader/NoteEditor.svelte';
	import {
		currentAccount, DurableProgressWriter, offlineAvailable, offlineStatus, readerOpened, saveMutation, syncNow
	} from '#lib/sync/client.js';
	import { OfflineStorageError } from '#lib/sync/db.js';
	import { loadBook as loadOfflineBook, loadFile, loadReaderState } from '#lib/sync/library.js';

	interface NoteDraft {
		id: string;
		highlightId: string | null;
		body: string;
		original: string;
		editing: boolean;
	}

	interface BookmarkDraft {
		id: string;
		label: string;
		original: string;
		editing: boolean;
	}

	let book = $state<Book | null>(null);
	let file = $state<BookFile | null>(null);
	let format = $state<ReaderFormat | null>(null);
	let opening = $state(true);
	let loadError = $state('');
	let actionError = $state('');
	let pendingError = $state('');
	let settingsWarning = $state('');
	let savedMessage = $state('');
	let closing = $state(false);
	let busy = $state(false);
	let ready = $state(false);
	let settings = $state<ReaderSettings>({ ...DEFAULT_SETTINGS });
	let highlights = $state<Highlight[]>([]);
	let bookmarks = $state<Bookmark[]>([]);
	let notes = $state<Note[]>([]);
	let location = $state<Relocation | null>(null);
	let selection = $state<ReaderSelection | null>(null);
	let selectedColor = $state<HighlightColor>('yellow');
	let draft = $state<NoteDraft | null>(null);
	let bookmarkDraft = $state<BookmarkDraft | null>(null);
	let showBookmarks = $state(false);
	let surface = $state<HTMLDivElement>();
	let reader: Reader | null = null;
	let progressWriter: DurableProgressWriter | null = null;
	const retiredProgressWriters = new Set<DurableProgressWriter>();
	let sessionClock: ReadingSessions | null = null;
	let savedBookSettings: { [key: string]: JsonValue } = {};
	let canSaveSettings = $state(true);
	let browserDeviceId = '';
	let requestVersion = 0;
	let mounted = true;
	const sessionWriter = new SessionWriter(reportPendingError, async (mutation) => {
		await saveMutation(mutation);
	});
	const orderedHighlights = $derived([...highlights].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)));
	const bookNotes = $derived(notes.filter((note) => note.highlight_id === null));
	const availableBookmarks = $derived(bookmarks.filter((bm) => bookmarkForPosition(bm, file?.id ?? -1, format ?? 'epub')));
	const progressPercent = $derived(Math.round((location?.fraction ?? 0) * 100));

	$effect(() => {
		const bookId = page.params.bookId ?? '';
		const fileId = page.params.fileId ?? '';
		const bookmarkId = page.url.searchParams.get('bookmark');
		untrack(() => { void openBook(bookId, fileId, bookmarkId); });
	});

	onMount(() => {
		const releaseReader = readerOpened();
		const unsubscribe = offlineStatus.subscribe((status) => {
			if (status.online && status.error && status.pending) pendingError = m['reader.error.save']();
		});
		const activity = () => { if (ready && !document.hidden) sessionClock?.activity(); };
		const visibility = () => {
			if (!ready) return;
			if (document.hidden) {
				sessionClock?.stop();
				flushInBackground();
			} else {
				sessionClock?.start();
			}
		};
		window.addEventListener('keydown', onKeydown);
		for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
			window.addEventListener(name, activity, { passive: true });
		}
		document.addEventListener('visibilitychange', visibility);
		return () => {
			releaseReader();
			unsubscribe();
			window.removeEventListener('keydown', onKeydown);
			for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
				window.removeEventListener(name, activity);
			}
			document.removeEventListener('visibilitychange', visibility);
		};
	});

	beforeNavigate((navigation) => {
		if (draft && draft.body !== draft.original && !window.confirm(m['reader.note.discard_confirm']())) {
			navigation.cancel();
			return;
		}
		if (bookmarkDraft && bookmarkDraft.label !== bookmarkDraft.original && !window.confirm(m['ux6.discard_confirm']())) {
			navigation.cancel();
			return;
		}
		sessionClock?.stop();
		flushInBackground();
	});

	onDestroy(() => {
		mounted = false;
		requestVersion += 1;
		sessionClock?.stop();
		flushInBackground();
		const current = reader;
		reader = null;
		if (current) void current.destroy().catch((error) => console.error('Could not close the reader', error));
	});

	function reportPendingError(error: unknown) {
		console.error('Could not save reading progress or session', error);
		if (mounted) pendingError = error instanceof SyncError && error.status === 'stale'
			? m['reader.error.conflict']()
			: m['reader.error.save']();
	}

	function reportActionError(error: unknown) {
		console.error('Reader action failed', error);
		actionError = error instanceof SyncError && error.status === 'stale'
			? m['reader.error.conflict']()
			: m['reader.error.save']();
	}

	function flushInBackground() {
		const options = { keepalive: true, signal: AbortSignal.timeout(2500) };
		if (progressWriter) void progressWriter.flush(options).catch(reportPendingError);
		for (const writer of retiredProgressWriters) {
			void writer.flush(options).then(() => retiredProgressWriters.delete(writer)).catch(reportPendingError);
		}
		void sessionWriter.flush(options).catch(reportPendingError);
	}

	async function flushForClose() {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2500);
		try {
			const writers = [...retiredProgressWriters, ...(progressWriter ? [progressWriter] : [])];
			await Promise.race([
				Promise.all([
					...writers.map(async (writer) => {
						await writer.flush({ keepalive: true, signal: controller.signal });
						retiredProgressWriters.delete(writer);
					}),
					sessionWriter.flush({ keepalive: true, signal: controller.signal })
				]),
				new Promise<never>((_, reject) => {
					controller.signal.addEventListener('abort', () => reject(new Error('Reader save timed out.')), { once: true });
				})
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async function openBook(rawBookId: string, rawFileId: string, bookmarkId: string | null) {
		const version = ++requestVersion;
		ready = false;
		sessionClock?.stop();
		sessionClock = null;
		if (progressWriter) retiredProgressWriters.add(progressWriter);
		progressWriter = null;
		flushInBackground();
		const previous = reader;
		reader = null;
		if (previous) {
			try {
				await previous.destroy();
			} catch (error) {
				console.error('Could not close the previous reader', error);
			}
		}
		if (version !== requestVersion) return;
		book = null;
		file = null;
		format = null;
		location = null;
		selection = null;
		highlights = [];
		bookmarks = [];
		notes = [];
		draft = null;
		bookmarkDraft = null;
		opening = true;
		loadError = '';
		actionError = '';
		settingsWarning = '';
		savedMessage = '';
		const bookId = Number(rawBookId);
		const fileId = Number(rawFileId);
		if (!Number.isSafeInteger(bookId) || bookId < 1 || !Number.isSafeInteger(fileId) || fileId < 1) {
			loadError = m['reader.error.not_found']();
			opening = false;
			return;
		}

		try {
			let loadedBook: Book;
			let state: Awaited<ReturnType<typeof getBookState>>;
			let storedSettings: Awaited<ReturnType<typeof getSettings>>;
			let offline = false;
			if (offlineAvailable()) {
				const loaded = await loadOfflineBook(currentAccount(), bookId);
				loadedBook = loaded.book;
				offline = loaded.offline;
				const saved = await loadReaderState(currentAccount(), bookId, offline);
				state = saved.state;
				storedSettings = saved.settings;
			} else {
				[loadedBook, state, storedSettings] = await Promise.all([
					getBook(bookId), getBookState(bookId), getSettings()
				]);
			}
			if (version !== requestVersion) return;
			const selectedFile = loadedBook.files.find((item) => item.id === fileId);
			if (!selectedFile) {
				loadError = m['reader.error.file_missing']();
				return;
			}
			const selectedFormat = readerFormat(selectedFile.format);
			if (!selectedFormat) {
				loadError = m['reader.error.unsupported']();
				return;
			}
			const blob = offlineAvailable()
				? await loadFile(currentAccount(), bookId, selectedFile, offline)
				: await downloadBookFile(bookId, selectedFile);
			if (version !== requestVersion) return;
			browserDeviceId = deviceId();
			const loadedSettings = loadReaderSettings(storedSettings, selectedFormat, bookId);
			settings = loadedSettings.settings;
			savedBookSettings = loadedSettings.bookValue;
			canSaveSettings = loadedSettings.canSave;
			if (loadedSettings.invalid) settingsWarning = canSaveSettings
				? m['reader.error.settings']()
				: m['reader.error.settings_locked']();
			book = loadedBook;
			file = selectedFile;
			format = selectedFormat;
			highlights = state.highlights.filter((highlight) => !highlight.deleted_at);
			bookmarks = state.bookmarks.filter((bookmark) => !bookmark.deleted_at);
			notes = state.notes.filter((note) => !note.deleted_at);
			progressWriter = new DurableProgressWriter(reportPendingError);
			await tick();
			if (version !== requestVersion) return;
			if (!surface) throw new Error('The reader surface is unavailable.');
			const currentReader = await createReader(selectedFormat, surface, {
				relocate: (next) => {
					if (version !== requestVersion) return;
					location = next;
					if (ready) {
						selection = null;
						progressWriter?.schedule(progressMutation(bookId, fileId, browserDeviceId, next));
					}
				},
				selection: (next) => { if (version === requestVersion && next) selection = next; },
				activity: () => { if (ready && !document.hidden) sessionClock?.activity(); },
				keyboard: onKeydown,
				error: (error) => {
					console.error('Reader rendering failed', error);
					if (version === requestVersion) actionError = m['reader.error.render']();
				}
			});
			if (version !== requestVersion) {
				await currentReader.destroy();
				return;
			}
			reader = currentReader;
			await currentReader.open(blob);
			if (version !== requestVersion) return;
			await currentReader.applySettings(settings);
			for (const highlight of highlights) {
				const annotation = annotationForReader(highlight, fileId, selectedFormat);
				if (annotation) {
					try {
						await currentReader.addAnnotation(annotation);
					} catch (error) {
						console.error('Could not restore a highlight', error);
						actionError = m['reader.error.render']();
					}
				}
			}
			await restorePosition(currentReader, state.progress, fileId, selectedFormat);
			if (bookmarkId) {
				const requested = bookmarks.find((item) => item.id === bookmarkId);
				if (!requested || !bookmarkForPosition(requested, fileId, selectedFormat)) {
					actionError = m['ux6.unavailable']();
				} else {
					try {
						await currentReader.goTo(requested.locator);
					} catch (error) {
						console.error('Could not open the saved bookmark', error);
						actionError = m['ux6.jump_failed']();
					}
				}
			}
			if (version !== requestVersion) return;
			if (!location) throw new Error('The reader did not report a position.');
			ready = true;
			progressWriter.schedule(progressMutation(bookId, fileId, browserDeviceId, location));
			sessionClock = new ReadingSessions(bookId, () => location?.fraction ?? 0, (mutation) => sessionWriter.enqueue(mutation));
			if (!document.hidden) sessionClock.start();
		} catch (cause) {
			if (version !== requestVersion) return;
			console.error('Could not open book', cause);
			loadError = cause instanceof ApiError
				? (cause.status === 404 ? m['reader.error.not_found']() : m['reader.error.api']())
				: cause instanceof OfflineStorageError ? m['offline.missing']()
				: cause instanceof TypeError ? m['reader.error.connection']() : m['reader.error.open']();
		} finally {
			if (version === requestVersion) opening = false;
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (!ready || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const target = event.target as HTMLElement | null;
		if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target?.tagName ?? '')) return;
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			void turnPage(event.key === 'ArrowLeft' ? 'previous' : 'next');
		}
	}

	async function turnPage(direction: 'previous' | 'next') {
		if (!reader || !ready) return;
		actionError = '';
		try {
			await reader[direction]();
		} catch (error) {
			console.error('Could not turn the page', error);
			actionError = m['reader.error.render']();
		}
	}

	async function goToPosition(value: number) {
		if (!reader || !ready) return;
		actionError = '';
		try {
			await reader.goTo(fraction(value / 1000));
		} catch (error) {
			console.error('Could not navigate to the reading position', error);
			actionError = m['reader.error.render']();
		}
	}

	async function closeReader() {
		if (!book || closing) return;
		if (draft && draft.body !== draft.original && !window.confirm(m['reader.note.discard_confirm']())) return;
		draft = null;
		closing = true;
		sessionClock?.stop();
		try {
			await flushForClose();
			await goto(`/books/${book.id}`);
		} catch (error) {
			console.error('Could not save while closing the reader', error);
			pendingError = m['reader.error.leave']();
			closing = false;
		}
	}

	async function retryWrites() {
		try {
			await flushForClose();
			if (navigator.onLine && offlineAvailable()) {
				const result = await syncNow(true);
				if (result.issues) throw new SyncError('stale');
			}
			pendingError = '';
			savedMessage = navigator.onLine ? m['reader.saved']() : m['offline.queued']();
		} catch (error) {
			reportPendingError(error);
		}
	}

	async function applySettings() {
		if (!reader || !isReaderSettings(settings)) return;
		try {
			await reader.applySettings(settings);
		} catch (error) {
			console.error('Could not apply reader settings', error);
			actionError = m['reader.error.render']();
		}
	}

	async function saveSettings() {
		if (!book || busy || !canSaveSettings) return;
		busy = true;
		actionError = '';
		savedMessage = '';
		try {
			const value = mergeBookSettings(savedBookSettings, settings);
			const outcome = await saveMutation({
				entity: 'user_settings',
				key: `reader.book.${book.id}`,
				op: 'upsert',
				data: { value },
				updated_at: Date.now()
			});
			savedBookSettings = value;
			settingsWarning = '';
			savedMessage = outcome === 'applied' ? m['reader.saved']() : m['offline.queued']();
		} catch (error) {
			reportActionError(error);
		} finally {
			busy = false;
		}
	}

	async function addHighlight() {
		if (!book || !file || !format || !reader || busy) return;
		const chosen = selection ?? (format === 'cbz' && location ? { ...location, text: '' } : null);
		if (!chosen) {
			actionError = m['reader.error.selection']();
			return;
		}
		busy = true;
		actionError = '';
		try {
			const mutation = makeHighlight(book.id, file.id, chosen, selectedColor);
			if (!('id' in mutation)) throw new Error('Highlight ID is missing.');
			await saveMutation(mutation);
			const now = new Date(mutation.updated_at).toISOString();
			const highlight: Highlight = {
				id: mutation.id, book_id: book.id, book_file_id: file.id, locator: chosen.locator,
				position: chosen.fraction, text: chosen.text, color: selectedColor, chapter: null,
				created_at: now, updated_at: now, deleted_at: null, rev: 0
			};
			highlights = [...highlights, highlight];
			const annotation = annotationForReader(highlight, file.id, format);
			if (annotation) await reader.addAnnotation(annotation);
			selection = null;
		} catch (error) {
			if (error instanceof Error && error.message === 'Highlight exceeds the server limits.') {
				actionError = m['reader.error.limit']();
			} else reportActionError(error);
		} finally {
			busy = false;
		}
	}

	async function changeHighlightColor(highlight: Highlight, color: string) {
		if (!reader || !file || !format || busy) return;
		const nextColor = highlightColor(color);
		busy = true;
		actionError = '';
		try {
			await saveMutation({
				entity: 'highlights', id: highlight.id, op: 'upsert', updated_at: Date.now(),
				data: {
					book_id: highlight.book_id, book_file_id: highlight.book_file_id,
					locator: highlight.locator, position: highlight.position, text: highlight.text,
					color: nextColor, chapter: highlight.chapter
				}
			});
			const previous = annotationForReader(highlight, file.id, format);
			const updated = { ...highlight, color: nextColor };
			highlights = highlights.map((item) => item.id === highlight.id ? updated : item);
			if (previous) {
				await reader.removeAnnotation(previous);
				const next = annotationForReader(updated, file.id, format);
				if (next) await reader.addAnnotation(next);
			}
		} catch (error) {
			reportActionError(error);
		} finally {
			busy = false;
		}
	}

	async function removeHighlight(highlight: Highlight) {
		if (!reader || !file || !format || busy || !window.confirm(m['reader.annotations.delete_highlight_confirm']())) return;
		busy = true;
		actionError = '';
		try {
			await saveMutation(deleteAnnotation('highlights', highlight.id));
			highlights = highlights.filter((item) => item.id !== highlight.id);
			notes = notes.filter((note) => note.highlight_id !== highlight.id);
			if (draft?.highlightId === highlight.id) draft = null;
			const annotation = annotationForReader(highlight, file.id, format);
			if (annotation) await reader.removeAnnotation(annotation);
		} catch (error) {
			reportActionError(error);
		} finally {
			busy = false;
		}
	}

	async function goToHighlight(highlight: Highlight) {
		if (!reader || !file || !format) return;
		const annotation = annotationForReader(highlight, file.id, format);
		if (!annotation) return;
		try {
			await reader.goTo(annotation.locator);
		} catch (error) {
			console.error('Could not navigate to highlight', error);
			actionError = m['reader.error.render']();
		}
	}

	function openNote(highlightId: string | null, note?: Note) {
		if (draft && draft.body !== draft.original && !window.confirm(m['reader.note.discard_confirm']())) return;
		draft = {
			id: note?.id ?? uuidv7(),
			highlightId,
			body: note?.body_md ?? '',
			original: note?.body_md ?? '',
			editing: !!note
		};
	}

	function cancelNote() {
		if (draft && draft.body !== draft.original && !window.confirm(m['reader.note.discard_confirm']())) return;
		draft = null;
	}

	async function saveNote() {
		if (!book || !draft || busy || !draft.body.trim()) return;
		const current = { ...draft };
		busy = true;
		actionError = '';
		try {
			const mutation = makeNote(book.id, current.body, current.highlightId, current.id);
			await saveMutation(mutation);
			const existing = notes.find((note) => note.id === current.id);
			const now = new Date(mutation.updated_at).toISOString();
			const note: Note = {
				id: current.id, book_id: book.id, highlight_id: current.highlightId, body_md: current.body,
				created_at: existing?.created_at ?? now, updated_at: now, deleted_at: null, rev: existing?.rev ?? 0
			};
			notes = existing ? notes.map((item) => item.id === note.id ? note : item) : [...notes, note];
			draft = null;
		} catch (error) {
			if (error instanceof Error && error.message === 'Note exceeds the server limit.') {
				actionError = m['reader.error.limit']();
			} else reportActionError(error);
		} finally {
			busy = false;
		}
	}

	async function removeNote(note: Note) {
		if (busy || !window.confirm(m['reader.annotations.delete_note_confirm']())) return;
		busy = true;
		actionError = '';
		try {
			await saveMutation(deleteAnnotation('notes', note.id));
			notes = notes.filter((item) => item.id !== note.id);
			if (draft?.id === note.id) draft = null;
		} catch (error) {
			reportActionError(error);
		} finally {
			busy = false;
		}
	}

	async function saveBookmark() {
		if (!book || !file || !location || !bookmarkDraft || busy || !reader) return;
		busy = true;
		actionError = '';
		const { id, label, editing } = bookmarkDraft;
		const savedLocation = location;
		try {
			const existing = bookmarks.find((bm) => bm.id === id);
			if (editing && !existing) throw new Error('The bookmark is no longer available.');
			const mutation = existing
				? updateBookmarkLabel(existing, label)
				: makeBookmark(book.id, file.id, savedLocation, label, id);
			const result = await saveMutation(mutation);
			const now = new Date(mutation.updated_at).toISOString();
			const bookmark: Bookmark = existing
				? { ...existing, label, updated_at: now }
				: {
					id, book_id: book.id, book_file_id: file.id, locator: savedLocation.locator,
					position: savedLocation.fraction, label, chapter: null,
					created_at: now, updated_at: now, deleted_at: null, rev: 0
				};
			bookmarks = existing ? bookmarks.map((item) => item.id === bookmark.id ? bookmark : item) : [...bookmarks, bookmark];
			bookmarkDraft = null;
			savedMessage = result === 'queued' ? m['ux6.queued']() : m['ux6.saved']();
		} catch (error) {
			if (error instanceof Error && error.message === 'Bookmark exceeds the server limits.') {
				actionError = m['ux6.limit']();
			} else reportActionError(error);
		} finally {
			busy = false;
		}
	}

	function editBookmark(bookmark: Bookmark) {
		bookmarkDraft = {
			id: bookmark.id,
			label: bookmark.label,
			original: bookmark.label,
			editing: true
		};
	}

	async function removeBookmark(bookmark: Bookmark) {
		if (busy || !window.confirm(m['ux6.delete_confirm']())) return;
		busy = true;
		actionError = '';
		try {
			const result = await saveMutation(deleteBookmark(bookmark.id));
			bookmarks = bookmarks.filter((item) => item.id !== bookmark.id);
			if (bookmarkDraft?.id === bookmark.id) bookmarkDraft = null;
			savedMessage = result === 'queued' ? m['ux6.queued']() : m['ux6.deleted']();
		} catch (error) {
			reportActionError(error);
		} finally {
			busy = false;
		}
	}

	async function jumpToBookmark(bookmark: Bookmark) {
		if (!reader || !file || !format || !bookmarkForPosition(bookmark, file.id, format)) {
			actionError = m['ux6.unavailable']();
			return;
		}
		try {
			await reader.goTo(bookmark.locator);
		} catch (error) {
			console.error('Could not jump to the saved bookmark', error);
			actionError = m['ux6.jump_failed']();
		}
	}

	function colorLabel(color: HighlightColor): string {
		switch (color) {
			case 'yellow': return m['reader.annotations.yellow']();
			case 'green': return m['reader.annotations.green']();
			case 'blue': return m['reader.annotations.blue']();
			case 'pink': return m['reader.annotations.pink']();
		}
	}
</script>

{#if loadError}
	<div class="space-y-4" role="alert">
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{loadError}</p>
		<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => openBook(page.params.bookId ?? '', page.params.fileId ?? '', page.url.searchParams.get('bookmark'))}>{m['reader.retry']()}</button>
		<a class="ml-4 underline underline-offset-4 focus-visible:outline-2" href="/read">{m['reader.back_to_books']()}</a>
	</div>
{:else if !book || !file || !format}
	<p class="text-slate-600" role="status">{m['reader.loading']()}</p>
{:else}
	<article class="space-y-6">
		<header class="flex flex-wrap items-start justify-between gap-4">
			<div class="min-w-0 space-y-2">
				<a class="text-sm text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2" href={`/books/${book.id}`}>{m['reader.back']()}</a>
				<h1 class="break-words text-2xl font-semibold tracking-tight">{book.title}</h1>
				<p class="text-sm text-slate-600">{file.format.toUpperCase()}</p>
			</div>
			<button class="rounded-md border border-slate-300 bg-white px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2" disabled={closing} onclick={closeReader}>
				{closing ? m['reader.closing']() : m['reader.close']()}
			</button>
		</header>

		{#if pendingError}
			<div role="alert" class="space-y-2 rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
				<p>{pendingError}</p>
				<button class="underline focus-visible:outline-2" onclick={retryWrites}>{m['reader.retry_saves']()}</button>
				<a class="ml-4 underline focus-visible:outline-2" href={`/books/${book.id}`}>{m['reader.leave_unsaved']()}</a>
			</div>
		{/if}
		{#if actionError}<p role="alert" class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{actionError}</p>{/if}
		{#if savedMessage}<p role="status" class="text-sm text-green-700">{savedMessage}</p>{/if}
		{#if opening}<p role="status" class="text-slate-600">{m['reader.loading']()}</p>{/if}

		<section aria-label={m['reader.surface']()} class="space-y-3">
			<!-- svelte-ignore a11y_no_noninteractive_tabindex: the book surface must be keyboard-scrollable -->
			<div bind:this={surface} role="region" aria-label={m['reader.surface']()} tabindex="0" class="h-[65vh] min-h-[24rem] overflow-hidden rounded-md border border-slate-300 bg-white focus-visible:outline-2 focus-visible:outline-offset-2"></div>
			<div class="flex flex-wrap items-center gap-3">
				<button class="rounded-md border border-slate-300 bg-white px-3 py-2 focus-visible:outline-2" disabled={!ready} onclick={() => turnPage('previous')}>{m['reader.previous']()}</button>
				<label for="reader-position" class="text-sm font-medium">{m['reader.position']()}</label>
				<input id="reader-position" class="min-w-28 flex-1 accent-slate-900 focus-visible:outline-2" type="range" min="0" max="1000" value={Math.round((location?.fraction ?? 0) * 1000)} aria-valuetext={`${progressPercent}%`} disabled={!ready} onchange={(event) => goToPosition(Number(event.currentTarget.value))} />
				<output for="reader-position" class="text-sm tabular-nums">{progressPercent}%</output>
				<button class="rounded-md border border-slate-300 bg-white px-3 py-2 focus-visible:outline-2" disabled={!ready} onclick={() => turnPage('next')}>{m['reader.next']()}</button>
			</div>
			<p class="text-sm text-slate-600">{m['reader.keyboard_hint']()}</p>
		</section>

		<details class="rounded-md border border-slate-200 bg-white p-4">
			<summary class="cursor-pointer text-lg font-semibold focus-visible:outline-2">{m['reader.settings.title']()}</summary>
			<div class="mt-4 space-y-4">
				<p class="text-sm text-slate-600">{m['reader.settings.scope']()}</p>
				{#if settingsWarning}<p role="alert" class="text-sm text-amber-800">{settingsWarning}</p>{/if}
				<div class="grid gap-4 sm:grid-cols-2">
					{#if format !== 'pdf' && format !== 'cbz'}
						<label class="space-y-1 text-sm font-medium">
							<span>{m['reader.settings.font']()}</span>
							<select class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2" bind:value={settings.font} onchange={applySettings} disabled={!ready}>
								<option value="serif">{m['reader.settings.serif']()}</option>
								<option value="sans-serif">{m['reader.settings.sans']()}</option>
								<option value="system">{m['reader.settings.system']()}</option>
							</select>
						</label>
						<label class="space-y-1 text-sm font-medium">
							<span>{m['reader.settings.spacing']()}: {settings.spacing}</span>
							<input class="block w-full accent-slate-900 focus-visible:outline-2" type="range" min="1" max="2.5" step="0.1" bind:value={settings.spacing} oninput={applySettings} disabled={!ready} />
						</label>
						<label class="space-y-1 text-sm font-medium">
							<span>{m['reader.settings.flow']()}</span>
							<select class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2" bind:value={settings.flow} onchange={applySettings} disabled={!ready}>
								<option value="paginated">{m['reader.settings.paginated']()}</option>
								<option value="scrolled">{m['reader.settings.scrolled']()}</option>
							</select>
						</label>
					{/if}
					<label class="space-y-1 text-sm font-medium">
						<span>{m['reader.settings.size']()}: {settings.size}%</span>
						<input class="block w-full accent-slate-900 focus-visible:outline-2" type="range" min="50" max="200" step="5" bind:value={settings.size} oninput={applySettings} disabled={!ready} />
					</label>
					{#if format !== 'cbz'}
						<label class="space-y-1 text-sm font-medium">
							<span>{m['reader.settings.theme']()}</span>
							<select class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2" bind:value={settings.theme} onchange={applySettings} disabled={!ready}>
								<option value="light">{m['reader.settings.light']()}</option>
								<option value="sepia">{m['reader.settings.sepia']()}</option>
								<option value="dark">{m['reader.settings.dark']()}</option>
							</select>
						</label>
					{/if}
				</div>
				<button class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={!ready || busy || !canSaveSettings} onclick={saveSettings}>{m['reader.settings.save']()}</button>
			</div>
		</details>

		<section aria-labelledby="annotations-heading" class="space-y-4">
			<h2 id="annotations-heading" class="text-xl font-semibold">{m['reader.annotations.title']()}</h2>
			<p class="text-sm text-slate-600">{m['reader.annotations.description']()}</p>
			{#if selection}
				<div class="rounded-md border-l-4 border-yellow-400 bg-yellow-50 p-3 text-sm">
					<p class="font-medium">{m['reader.annotations.selected']()}</p>
					<p class="mt-1 whitespace-pre-wrap break-words">{selection.text}</p>
				</div>
			{/if}
			<div class="flex flex-wrap items-end gap-3">
				<label class="space-y-1 text-sm font-medium">
					<span>{m['reader.annotations.color']()}</span>
					<select class="block rounded-md border border-slate-300 bg-white p-2 focus-visible:outline-2" bind:value={selectedColor}>
						{#each HIGHLIGHT_COLORS as color}<option value={color}>{colorLabel(color)}</option>{/each}
					</select>
				</label>
				<button class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={!ready || busy || (!selection && format !== 'cbz')} onclick={addHighlight}>
					{format === 'cbz' && !selection ? m['reader.annotations.add_page']() : m['reader.annotations.add_highlight']()}
				</button>
				<button class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium focus-visible:outline-2" disabled={!ready || busy} onclick={() => openNote(null)}>{m['reader.annotations.add_note']()}</button>
			</div>

			{#if draft}
				<form class="space-y-4 rounded-md border border-slate-300 bg-slate-50 p-4" onsubmit={(event) => { event.preventDefault(); void saveNote(); }}>
					<h3 class="font-semibold">{draft.editing ? m['reader.note.edit']() : m['reader.note.new']()}</h3>
					{#key draft.id}
						<NoteEditor value={draft.body} onChange={(value) => { if (draft) draft.body = value; }} />
					{/key}
					<div class="flex flex-wrap gap-3">
						<button class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={busy || !draft.body.trim()}>{m['reader.note.save']()}</button>
						<button type="button" class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2" onclick={cancelNote}>{m['reader.note.cancel']()}</button>
					</div>
				</form>
			{/if}

			{#if !highlights.length && !notes.length}
				<p class="text-slate-600">{m['reader.annotations.empty']()}</p>
			{/if}
			{#if bookNotes.length}
				<div class="space-y-3">
					<h3 class="font-semibold">{m['reader.annotations.book_notes']()}</h3>
					{#each bookNotes as note (note.id)}
						<div class="space-y-3 rounded-md border border-slate-200 bg-white p-4">
							<div class="reader-markdown break-words text-sm">{@html renderMarkdown(note.body_md)}</div>
							<div class="flex gap-4 text-sm">
								<button class="underline focus-visible:outline-2" onclick={() => openNote(null, note)}>{m['reader.annotations.edit']()}</button>
								<button class="underline focus-visible:outline-2" disabled={busy} onclick={() => removeNote(note)}>{m['reader.annotations.delete']()}</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
			{#each orderedHighlights as highlight (highlight.id)}
				<div class="space-y-3 rounded-md border border-slate-200 bg-white p-4">
					<blockquote class="whitespace-pre-wrap break-words border-l-4 border-yellow-400 pl-3">{highlight.text || m['reader.annotations.page_highlight']()}</blockquote>
					<div class="flex flex-wrap items-end gap-3 text-sm">
						{#if annotationForReader(highlight, file.id, format)}
							<button class="underline focus-visible:outline-2" onclick={() => goToHighlight(highlight)}>{m['reader.annotations.go_to']()}</button>
						{:else}
							<span class="text-slate-600">{m['reader.annotations.other_file']()}</span>
						{/if}
						<label class="space-y-1">
							<span>{m['reader.annotations.color']()}</span>
							<select class="block rounded-md border border-slate-300 p-1 focus-visible:outline-2" value={highlightColor(highlight.color)} disabled={busy} onchange={(event) => changeHighlightColor(highlight, event.currentTarget.value)}>
								{#each HIGHLIGHT_COLORS as color}<option value={color}>{colorLabel(color)}</option>{/each}
							</select>
						</label>
						<button class="underline focus-visible:outline-2" disabled={busy} onclick={() => openNote(highlight.id)}>{m['reader.annotations.attach_note']()}</button>
						<button class="underline focus-visible:outline-2" disabled={busy} onclick={() => removeHighlight(highlight)}>{m['reader.annotations.delete']()}</button>
					</div>
					{#each notes.filter((note) => note.highlight_id === highlight.id) as note (note.id)}
						<div class="space-y-2 rounded-md bg-slate-50 p-3">
							<div class="reader-markdown break-words text-sm">{@html renderMarkdown(note.body_md)}</div>
							<div class="flex gap-4 text-sm">
								<button class="underline focus-visible:outline-2" onclick={() => openNote(highlight.id, note)}>{m['reader.annotations.edit']()}</button>
								<button class="underline focus-visible:outline-2" disabled={busy} onclick={() => removeNote(note)}>{m['reader.annotations.delete']()}</button>
							</div>
						</div>
					{/each}
				</div>
			{/each}
		</section>

		<section aria-labelledby="bookmarks-heading" class="space-y-4">
			<div class="flex items-center justify-between">
				<h2 id="bookmarks-heading" class="text-xl font-semibold">{m['ux6.title']()}</h2>
				<button class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium focus-visible:outline-2" aria-expanded={showBookmarks} disabled={!ready || busy} onclick={() => showBookmarks = !showBookmarks}>
					{showBookmarks ? m['ux6.hide']() : m['ux6.show']()} ({bookmarks.length})
				</button>
			</div>
			<div class="flex flex-wrap gap-3">
				<button class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={!ready || busy} onclick={() => bookmarkDraft = { id: uuidv7(), label: '', original: '', editing: false }}>{m['ux6.save_position']()}</button>
				{#if availableBookmarks.length > 0}
					<select aria-label={m['ux6.jump']()} class="rounded-md border border-slate-300 p-2 focus-visible:outline-2" disabled={!ready || busy} onchange={(event) => {
						const bm = availableBookmarks.find((b) => b.id === event.currentTarget.value);
						if (bm) void jumpToBookmark(bm);
						event.currentTarget.value = '';
					}}>
						<option value="">{m['ux6.jump']()}</option>
						{#each availableBookmarks as bookmark (bookmark.id)}
							<option value={bookmark.id}>{bookmark.label || m['ux6.unnamed']()}</option>
						{/each}
					</select>
				{/if}
			</div>

			{#if bookmarkDraft}
				<form class="space-y-3 rounded-md border border-slate-300 bg-slate-50 p-4" onsubmit={(event) => { event.preventDefault(); void saveBookmark(); }}>
					<h3 class="font-semibold">{bookmarkDraft.editing ? m['ux6.edit_title']() : m['ux6.new_title']()}</h3>
					<label class="space-y-1 text-sm font-medium">
						<span>{m['ux6.label']()}</span>
						<input
							type="text"
							class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2"
							bind:value={bookmarkDraft.label}
							maxlength="512"
							disabled={busy}
						/>
					</label>
					<div class="flex flex-wrap gap-3">
						<button type="submit" class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={busy}>{m['ux6.save']()}</button>
						<button type="button" class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2" disabled={busy} onclick={() => { bookmarkDraft = null; }}>{m['ux6.cancel']()}</button>
					</div>
				</form>
			{/if}

			{#if !bookmarks.length}
				<p class="text-slate-600">{m['ux6.empty']()}</p>
			{:else if showBookmarks}
				<div class="space-y-3">
					{#each bookmarks as bookmark (bookmark.id)}
						<div class="space-y-2 rounded-md border border-slate-200 bg-white p-4">
							<div class="flex items-start justify-between">
								<div class="min-w-0 flex-1">
									<p class="font-semibold">{bookmark.label || m['ux6.unnamed']()}</p>
									<p class="text-sm text-slate-600">{(Math.round(bookmark.position * 1000) / 10).toFixed(1)}%{bookmark.chapter ? ` — ${bookmark.chapter}` : ''}</p>
									{#if !bookmarkForPosition(bookmark, file.id, format)}
										<p class="text-sm text-amber-800">{m['ux6.unavailable']()}</p>
									{/if}
								</div>
								<time class="whitespace-nowrap text-sm text-slate-600">{new Date(bookmark.created_at).toLocaleDateString()}</time>
							</div>
							<div class="flex flex-wrap gap-3 text-sm">
								<button class="underline focus-visible:outline-2" disabled={busy || !bookmarkForPosition(bookmark, file.id, format)} onclick={() => void jumpToBookmark(bookmark)}>{m['ux6.jump']()}</button>
								<button class="underline focus-visible:outline-2" disabled={busy || bookmark.book_file_id === null} onclick={() => editBookmark(bookmark)}>{m['ux6.edit']()}</button>
								<button class="underline focus-visible:outline-2" disabled={busy} onclick={() => void removeBookmark(bookmark)}>{m['ux6.delete']()}</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	</article>
{/if}

<style>
	.reader-markdown :global(p),
	.reader-markdown :global(ul),
	.reader-markdown :global(ol),
	.reader-markdown :global(pre) {
		margin-block: 0.5rem;
	}

	.reader-markdown :global(a) {
		color: #1d4ed8;
		text-decoration: underline;
	}
</style>
