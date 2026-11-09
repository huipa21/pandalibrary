import { untrack } from 'svelte';
import { goto } from '$app/navigation';
import { v7 as uuidv7 } from 'uuid';
import * as m from '#lib/paraglide/messages.js';
import { ApiError, type JsonValue } from '#lib/api/client.js';
import { getBook } from '#lib/catalog/api.js';
import type { Book, BookFile } from '#lib/catalog/types.js';
import { createReader, readerFormat } from '#lib/reader/index.js';
import { deviceId, downloadBookFile, getBookState, getSettings, SyncError } from '#lib/reader/api.js';
import { annotationForReader, deleteAnnotation, highlightColor, makeHighlight, makeNote, type HighlightColor } from '#lib/reader/annotations.js';
import { bookmarkForPosition, deleteBookmark, makeBookmark, updateBookmarkLabel } from '#lib/reader/bookmarks.js';
import { fraction, progressMutation, restorePosition } from '#lib/reader/progress.js';
import { ReadingSessions, SessionWriter } from '#lib/reader/sessions.js';
import { DEFAULT_SETTINGS, isReaderSettings, loadReaderSettings, mergeBookSettings } from '#lib/reader/settings.js';
import type { Bookmark, Highlight, Note, Reader, ReaderFormat, ReaderSelection, ReaderSettings, Relocation } from '#lib/reader/types.js';
import {
	currentAccount, DurableProgressWriter, offlineAvailable, offlineStatus, readerOpened, saveMutation, syncNow
} from '#lib/sync/client.js';
import { OfflineStorageError } from '#lib/sync/db.js';
import { loadBook as loadOfflineBook, loadFile, loadReaderState } from '#lib/sync/library.js';
import { flushReaderWrites } from './flush.js';

export interface NoteDraft {
	id: string;
	highlightId: string | null;
	body: string;
	original: string;
	editing: boolean;
}

export interface BookmarkDraft {
	id: string;
	label: string;
	original: string;
	editing: boolean;
}

export function createReaderController(params: () => { bookId: string; fileId: string; bookmarkId: string | null; highlightId: string | null }) {

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
	let reader: Reader | null = null;
	let progressWriter: DurableProgressWriter | null = null;
	const retiredProgressWriters = new Set<DurableProgressWriter>();
	let sessionClock: ReadingSessions | null = null;
	let savedBookSettings: { [key: string]: JsonValue } = {};
	let savedFormatSettings: { [key: string]: JsonValue } = {};
	let canSaveFormatSettings = true;
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

	$effect(() => {
		const { bookId, fileId, bookmarkId, highlightId } = params();
		untrack(() => { void openBook(bookId, fileId, bookmarkId, highlightId); });
	});
	let draftGuard = () => true;
	function setDraftGuard(guard: () => boolean) { draftGuard = guard; }

	function mount() {
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
	}

	function beforeNavigate(navigation: { cancel(): void }) {
		if (!closing && !draftGuard()) {
			navigation.cancel();
			return;
		}
		sessionClock?.stop();
		flushInBackground();
	}

	function dispose() {
		mounted = false;
		requestVersion += 1;
		sessionClock?.stop();
		flushInBackground();
		const current = reader;
		reader = null;
		if (current) void current.destroy().catch((error) => console.error('Could not close the reader', error));
	}

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
		await flushReaderWrites(progressWriter, retiredProgressWriters, sessionWriter);
	}

	async function openBook(rawBookId: string, rawFileId: string, bookmarkId: string | null, highlightId: string | null = null) {
		const version = ++requestVersion;
		loaded = null;
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
			const formatValue = storedSettings.find((setting) => setting.key === `reader.${selectedFormat}`)?.value;
			canSaveFormatSettings = formatValue === undefined || (typeof formatValue === 'object' && formatValue !== null && !Array.isArray(formatValue));
			savedFormatSettings = typeof formatValue === 'object' && formatValue !== null && !Array.isArray(formatValue) ? formatValue : {};
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
			loaded = { version, bookId, fileId, selectedFormat, blob, state, bookmarkId, highlightId };
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

	async function goToFraction(value: number) {
		if (!reader || !ready) return;
		actionError = '';
		try {
			await reader.goTo(fraction(value));
		} catch (error) {
			console.error('Could not navigate to the reading position', error);
			actionError = m['reader.error.render']();
		}
	}

	async function closeReader() {
		if (!book || closing) return;
		if (!draftGuard()) return;
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

	async function applySettings(partial: Partial<ReaderSettings> = {}) {
		const next = { ...settings, ...partial };
		if (!isReaderSettings(next)) {
			console.error('Rejected invalid reader settings');
			actionError = m['reader.error.settings']();
			return;
		}
		settings = next;
		if (!reader) return;
		try {
			await reader.applySettings(settings);
		} catch (error) {
			console.error('Could not apply reader settings', error);
			actionError = m['reader.error.render']();
		}
	}

	async function saveSettings(partial: Partial<ReaderSettings> = {}, scope: 'book' | 'format' = 'book') {
		settings = { ...settings, ...partial };
		if (!book || busy) return;
		if (!(scope === 'book' ? canSaveSettings : canSaveFormatSettings)) {
			actionError = m['reader.error.settings_locked']();
			return;
		}
		busy = true;
		actionError = '';
		savedMessage = '';
		try {
			const value = mergeBookSettings(scope === 'book' ? savedBookSettings : savedFormatSettings, settings);
			const outcome = await saveMutation({
				entity: 'user_settings',
				key: scope === 'book' ? `reader.book.${book.id}` : `reader.${format}`,
				op: 'upsert',
				data: { value },
				updated_at: Date.now()
			});
			if (scope === 'book') savedBookSettings = value;
			else savedFormatSettings = value;
			settingsWarning = '';
			savedMessage = outcome === 'applied' ? m['reader.saved']() : m['offline.queued']();
		} catch (error) {
			reportActionError(error);
		} finally {
			busy = false;
		}
	}

	async function addHighlight(chosenSelection: ReaderSelection | null = selection, color: HighlightColor = 'yellow') {
		if (!book || !file || !format || !reader || busy) return;
		const chosen = chosenSelection ?? (format === 'cbz' && location ? { ...location, text: '' } : null);
		if (!chosen) {
			actionError = m['reader.error.selection']();
			return;
		}
		busy = true;
		actionError = '';
		try {
			const mutation = makeHighlight(book.id, file.id, chosen, color);
			if (!('id' in mutation)) throw new Error('Highlight ID is missing.');
			await saveMutation(mutation);
			const now = new Date(mutation.updated_at).toISOString();
			const highlight: Highlight = {
				id: mutation.id, book_id: book.id, book_file_id: file.id, locator: chosen.locator,
				position: chosen.fraction, text: chosen.text, color, chapter: null,
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

	async function saveNote(draft: NoteDraft) {
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
			return true;
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
		} catch (error) {
			reportActionError(error);
		} finally {
			busy = false;
		}
	}

	async function saveBookmark(bookmarkDraft: BookmarkDraft) {
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
			savedMessage = result === 'queued' ? m['ux6.queued']() : m['ux6.saved']();
			return true;
		} catch (error) {
			if (error instanceof Error && error.message === 'Bookmark exceeds the server limits.') {
				actionError = m['ux6.limit']();
			} else reportActionError(error);
		} finally {
			busy = false;
		}
	}

	async function removeBookmark(bookmark: Bookmark) {
		if (busy || !window.confirm(m['ux6.delete_confirm']())) return;
		busy = true;
		actionError = '';
		try {
			const result = await saveMutation(deleteBookmark(bookmark.id));
			bookmarks = bookmarks.filter((item) => item.id !== bookmark.id);
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

	let loaded: {
		version: number; bookId: number; fileId: number; selectedFormat: ReaderFormat;
		blob: Blob; state: Awaited<ReturnType<typeof getBookState>>;
		bookmarkId: string | null; highlightId: string | null;
	} | null = null;
	async function attach(surface: HTMLElement): Promise<Reader> {
		if (!loaded) throw new Error('The reader has not loaded.');
		const { version, bookId, fileId, selectedFormat, blob, state, bookmarkId, highlightId } = loaded;
		opening = true;
		try {
			const currentReader = await createReader(selectedFormat, surface, {
				relocate: (next) => { if (version === requestVersion) relocate(next); },
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
				throw new Error('Reader opening was superseded.');
			}
			reader = currentReader;
			await currentReader.open(blob);
			if (version !== requestVersion) throw new Error('Reader opening was superseded.');
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
			if (highlightId) {
				// Unknown IDs and highlights from another file or format are ignored silently.
				const requested = highlights.find((item) => item.id === highlightId);
				const annotation = requested ? annotationForReader(requested, fileId, selectedFormat) : null;
				if (annotation) {
					try {
						await currentReader.goTo(annotation.locator);
					} catch (error) {
						console.error('Could not open the highlight', error);
					}
				}
			}
			if (version !== requestVersion) throw new Error('Reader opening was superseded.');
			if (!location) throw new Error('The reader did not report a position.');
			ready = true;
			progressWriter?.schedule(progressMutation(bookId, fileId, browserDeviceId, location));
			sessionClock = new ReadingSessions(bookId, () => location?.fraction ?? 0, (mutation) => sessionWriter.enqueue(mutation));
			if (!document.hidden) sessionClock.start();
			return currentReader;
		} catch (error) {
			if (version === requestVersion) {
				console.error('Could not attach the reader', error);
				loadError = m['reader.error.open']();
			}
			throw error;
		} finally {
			if (version === requestVersion) opening = false;
		}
	}

	function relocate(next: Relocation) {
		location = next;
		if (ready && book && file) {
			selection = null;
			progressWriter?.schedule(progressMutation(book.id, file.id, browserDeviceId, next));
		}
	}
	return {
		get book() { return book; },
		get file() { return file; },
		get format() { return format; },
		get opening() { return opening; },
		get ready() { return ready; },
		get loadError() { return loadError; },
		get actionError() { return actionError; },
		get pendingError() { return pendingError; },
		get savedMessage() { return savedMessage; },
		get closing() { return closing; },
		get busy() { return busy; },
		get settings() { return settings; },
		get canSaveSettings() { return canSaveSettings; },
		get settingsWarning() { return settingsWarning; },
		get highlights() { return highlights; },
		get notes() { return notes; },
		get bookmarks() { return bookmarks; },
		get location() { return location; },
		get selection() { return selection; },
		get orderedHighlights() { return orderedHighlights; },
		get bookNotes() { return bookNotes; },
		get availableBookmarks() { return availableBookmarks; },
		mount, dispose, beforeNavigate, setDraftGuard, attach, turnPage, goToFraction, goToHighlight, removeHighlight, removeBookmark, jumpToBookmark, retryWrites, applySettings, saveSettings, addHighlight, saveNote,
		close: closeReader,
		retry: () => { const p = params(); return openBook(p.bookId, p.fileId, p.bookmarkId, p.highlightId); },
		updateHighlight: (highlight: Highlight, patch: { color?: string }) => changeHighlightColor(highlight, patch.color ?? highlight.color),
		deleteNote: removeNote,
		addBookmark: (input: { label: string; id?: string }) => saveBookmark({ id: input.id ?? uuidv7(), label: input.label, original: '', editing: false }),
		updateBookmark: (bookmark: Bookmark, input: { label: string }) => saveBookmark({ id: bookmark.id, label: input.label, original: bookmark.label, editing: true }),
		relocate
	};
}

export type ReaderController = ReturnType<typeof createReaderController>;
