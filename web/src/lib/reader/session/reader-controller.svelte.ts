import { untrack } from 'svelte';
import { goto } from '$app/navigation';
import { v7 as uuidv7 } from 'uuid';
import * as m from '#lib/paraglide/messages.js';
import { ApiError, type JsonValue } from '#lib/api/client.js';
import { getBook } from '#lib/catalog/api.js';
import type { Book, BookFile } from '#lib/catalog/types.js';
import { createReader, readerFormat } from '#lib/reader/index.js';
import { deviceId, downloadBookFile, getBookState, getSettings, SyncError } from '#lib/reader/api.js';
import { annotationForReader, deleteAnnotation, highlightColor, isMarkColor, makeHighlight, makeNote, type MarkColor } from '#lib/reader/annotations.js';
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
import { readerState as cachedReaderState } from '#lib/sync/state.js';
import { flushReaderWrites } from './flush.js';
import { deletePageAnnotation, makePageAnnotation, validatePageAnnotationInput } from '#lib/reader/page-annotations.js';
import type { HighlightStyle, PageAnnotation, PageAnnotationInput } from '#lib/reader/types.js';
import { pdfSettingsForScope, initialPdfSettings } from './pdf-settings.js';

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
	// True while pendingError only mirrors a failed outbox sync, which clears itself once the outbox drains.
	let statusAlert = false;
	let settingsWarning = $state('');
	let savedMessage = $state('');
	let closing = $state(false);
	let busy = $state(false);
	let ready = $state(false);
	let settings = $state<ReaderSettings>({ ...DEFAULT_SETTINGS });
	let highlights = $state<Highlight[]>([]);
	let bookmarks = $state<Bookmark[]>([]);
	let notes = $state<Note[]>([]);
	let pageAnnotations = $state<PageAnnotation[]>([]);
	let otherPageAnnotations = $state<PageAnnotation[]>([]);
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
	let annotationVersion = 0;
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
	const additionalDraftGuards = new Set<() => boolean>();
	function registerDraftGuard(guard: () => boolean) {
		additionalDraftGuards.add(guard);
		return () => { additionalDraftGuards.delete(guard); };
	}
	function canLeaveDrafts() {
		return draftGuard() && [...additionalDraftGuards].every((guard) => guard());
	}
	let saveView = async () => {};
	function setViewSave(save: () => Promise<void>) { saveView = save; }

	function mount() {
		const releaseReader = readerOpened();
		let syncing = false;
		const unsubscribe = offlineStatus.subscribe((status) => {
			if (status.online && status.error && status.pending && (!pendingError || statusAlert)) {
				pendingError = m['reader.error.save']();
				statusAlert = true;
			} else if (statusAlert && !status.error && !status.pending && !status.issues) {
				pendingError = '';
				statusAlert = false;
			}
			if (syncing && !status.syncing && !status.error && offlineAvailable()) void refreshPageAnnotations();
			syncing = status.syncing;
		});
		const activity = () => { if (ready && !document.hidden) sessionClock?.activity(); };
		const visibility = () => {
			if (!ready) return;
			if (document.hidden) {
				sessionClock?.stop();
				if (!closing) void saveView().catch(reportPendingError);
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

	async function refreshPageAnnotations() {
		if (!book || !file || format !== 'pdf') return;
		const version = requestVersion;
		while (busy && mounted && version === requestVersion) await new Promise((resolve) => setTimeout(resolve, 25));
		if (!mounted || version !== requestVersion) return;
		const revision = annotationVersion;
		const fileId = file.id;
		try {
			const { state } = await cachedReaderState(currentAccount(), book.id);
			if (mounted && version === requestVersion && revision === annotationVersion && !busy) {
				pageAnnotations = (state.page_annotations ?? []).filter((row) => !row.deleted_at && row.book_file_id === fileId);
				otherPageAnnotations = (state.page_annotations ?? []).filter((row) => !row.deleted_at && row.book_file_id !== fileId);
			}
		} catch (error) {
			if (version === requestVersion) reportActionError(error);
		}
	}

	function beforeNavigate(navigation: { cancel(): void }) {
		if (!closing && !canLeaveDrafts()) {
			navigation.cancel();
			return;
		}
		sessionClock?.stop();
		if (!closing) void saveView().catch(reportPendingError);
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
		if (mounted) {
			statusAlert = false;
			pendingError = error instanceof SyncError && error.status === 'stale'
				? m['reader.error.conflict']()
				: m['reader.error.save']();
		}
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
		await saveView();
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
		pageAnnotations = [];
		otherPageAnnotations = [];
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
			settings = selectedFormat === 'pdf'
				? initialPdfSettings(loadedSettings.settings, loadedSettings.bookValue, storedSettings.find((row) => row.key === 'reader.pdf')?.value)
				: loadedSettings.settings;
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
			pageAnnotations = (state.page_annotations ?? []).filter((row) => !row.deleted_at && row.book_file_id === fileId);
			otherPageAnnotations = (state.page_annotations ?? []).filter((row) => !row.deleted_at && row.book_file_id !== fileId);
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
		// PDF owns navigation, including continuous scrolling and menu guards.
		if (format === 'pdf') return;
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
		if (!canLeaveDrafts()) return;
		closing = true;
		sessionClock?.stop();
		try {
			await flushForClose();
			await goto(`/books/${book.id}`);
		} catch (error) {
			console.error('Could not save while closing the reader', error);
			statusAlert = false;
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
			statusAlert = false;
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

	async function saveSettings(partial: Partial<ReaderSettings> = {}, options: 'book' | 'format' | { scope: 'book' | 'format' | 'both' } = 'book') {
		const scope = typeof options === 'string' ? options : options.scope;
		const next = { ...settings, ...partial };
		if (!isReaderSettings(next)) {
			console.error('Rejected invalid reader settings');
			actionError = m['reader.error.settings']();
			return false;
		}
		settings = next;
		if (!book || busy) return false;
		if ((scope !== 'format' && !canSaveSettings) || (scope !== 'book' && !canSaveFormatSettings)) {
			actionError = m['reader.error.settings_locked']();
			settingsWarning = actionError;
			return false;
		}
		const version = requestVersion;
		const bookId = book.id;
		const selectedFormat = format;
		busy = true;
		actionError = '';
		savedMessage = '';
		try {
			let outcome: Awaited<ReturnType<typeof saveMutation>> = 'applied';
			for (const target of scope === 'both' ? ['book', 'format'] as const : [scope]) {
				const original = target === 'book' ? savedBookSettings : savedFormatSettings;
				const value = selectedFormat === 'pdf'
					? pdfSettingsForScope(original, settings, target)
					: mergeBookSettings(original, settings);
				outcome = await saveMutation({
					entity: 'user_settings', key: target === 'book' ? `reader.book.${bookId}` : `reader.${selectedFormat}`,
					op: 'upsert', data: { value }, updated_at: Date.now()
				});
				if (version !== requestVersion) return false;
				if (target === 'book') savedBookSettings = value;
				else savedFormatSettings = value;
			}
			settingsWarning = '';
			savedMessage = outcome === 'applied' ? m['reader.saved']() : m['offline.queued']();
			return true;
		} catch (error) {
			if (version === requestVersion) {
				reportActionError(error);
				settingsWarning = actionError;
			}
			return false;
		} finally {
			busy = false;
		}
	}

	/** Creates a highlight and returns the new row, or null when nothing was saved. */
	async function addHighlight(
		chosenSelection: ReaderSelection | null = selection,
		color: MarkColor = 'yellow',
		style: HighlightStyle = 'highlight'
	): Promise<Highlight | null> {
		if (!book || !file || !format || !reader || busy) return null;
		const chosen = chosenSelection ?? (format === 'cbz' && location ? { ...location, text: '' } : null);
		if (!chosen) {
			actionError = m['reader.error.selection']();
			return null;
		}
		busy = true;
		actionError = '';
		try {
			const mutation = makeHighlight(book.id, file.id, chosen, color, undefined, style);
			if (!('id' in mutation)) throw new Error('Highlight ID is missing.');
			await saveMutation(mutation);
			const now = new Date(mutation.updated_at).toISOString();
			const highlight: Highlight = {
				id: mutation.id, book_id: book.id, book_file_id: file.id, locator: chosen.locator,
				position: chosen.fraction, text: chosen.text, color: highlightColor(color), style, chapter: null,
				created_at: now, updated_at: now, deleted_at: null, rev: 0
			};
			highlights = [...highlights, highlight];
			const annotation = annotationForReader(highlight, file.id, format);
			if (annotation) await reader.addAnnotation(annotation);
			selection = null;
			return highlight;
		} catch (error) {
			if (error instanceof Error && error.message === 'Highlight exceeds the server limits.') {
				actionError = m['reader.error.limit']();
			} else reportActionError(error);
			return null;
		} finally {
			busy = false;
		}
	}

	async function changeHighlight(highlight: Highlight, patch: { color?: string; style?: HighlightStyle }) {
		if (!reader || !file || !format || busy) return false;
		busy = true;
		actionError = '';
		try {
			if (patch.color !== undefined && !isMarkColor(patch.color)) throw new Error('Invalid highlight color.');
			const nextColor = patch.color === undefined ? highlight.color : highlightColor(patch.color);
			const style = patch.style ?? highlight.style ?? 'highlight';
			await saveMutation({
				entity: 'highlights', id: highlight.id, op: 'upsert', updated_at: Date.now(),
				data: {
					book_id: highlight.book_id, book_file_id: highlight.book_file_id,
					locator: highlight.locator, position: highlight.position, text: highlight.text,
					color: nextColor, style, chapter: highlight.chapter
				}
			});
			const previous = annotationForReader(highlight, file.id, format);
			const updated = { ...highlight, color: nextColor, style };
			highlights = highlights.map((item) => item.id === highlight.id ? updated : item);
			if (previous) {
				await reader.removeAnnotation(previous);
				const next = annotationForReader(updated, file.id, format);
				if (next) await reader.addAnnotation(next);
			}
			return true;
		} catch (error) {
			reportActionError(error);
			return false;
		} finally {
			busy = false;
		}
	}

	async function removeHighlight(highlight: Highlight, options: { confirm?: boolean } = {}) {
		if (!reader || !file || !format || busy) return;
		if (options.confirm !== false && !window.confirm(m['reader.annotations.delete_highlight_confirm']())) return;
		busy = true;
		actionError = '';
		try {
			await saveMutation(deleteAnnotation('highlights', highlight.id));
			highlights = highlights.filter((item) => item.id !== highlight.id);
			notes = notes.filter((note) => note.highlight_id !== highlight.id);
			const annotation = annotationForReader(highlight, file.id, format);
			if (annotation) await reader.removeAnnotation(annotation);
			return true;
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
			return true;
		} catch (error) {
			reportActionError(error);
		} finally {
			busy = false;
		}
	}

	/** `at` bookmarks a specific position (for example a PDF selection) instead of the current location. */
	async function saveBookmark(bookmarkDraft: BookmarkDraft, at: Relocation | null = null) {
		if (!book || !file || !(at ?? location) || !bookmarkDraft || busy || !reader) return;
		busy = true;
		actionError = '';
		const { id, label, editing } = bookmarkDraft;
		const savedLocation = (at ?? location)!;
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
			return true;
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

	async function restoreDeletedAnnotation(
		entry: { kind: 'mark'; row: Highlight; notes: Note[] } |
			{ kind: 'bookmark'; row: Bookmark } |
			{ kind: 'note'; row: Note } |
			{ kind: 'insert'; row: PageAnnotation }
	) {
		if (!book || !file || !format || !reader || busy) return false;
		if (entry.row.book_id !== book.id || (entry.kind !== 'note' && entry.row.book_file_id !== file.id)) {
			reportActionError(new Error('Cannot restore an annotation from another file.'));
			return false;
		}
		busy = true;
		actionError = '';
		try {
			const { row } = entry;
			const updated_at = Date.now();
			if (entry.kind === 'mark') {
				const h = entry.row;
				await saveMutation({
					entity: 'highlights', id: h.id, op: 'upsert', updated_at,
					data: { book_id: h.book_id, book_file_id: h.book_file_id, locator: h.locator, position: h.position,
						text: h.text, color: h.color, style: h.style ?? 'highlight', chapter: h.chapter }
				});
				highlights = [...highlights.filter((item) => item.id !== h.id), { ...h, deleted_at: null }];
				const annotation = annotationForReader(h, file.id, format);
				if (annotation) await reader.addAnnotation(annotation);
				for (const note of entry.notes) {
					await saveMutation(makeNote(book.id, note.body_md, h.id, note.id));
					notes = [...notes.filter((item) => item.id !== note.id), { ...note, deleted_at: null }];
				}
			} else if (entry.kind === 'bookmark') {
				await saveMutation(updateBookmarkLabel(entry.row, entry.row.label));
				bookmarks = [...bookmarks.filter((item) => item.id !== row.id), { ...entry.row, deleted_at: null }];
			} else if (entry.kind === 'note') {
				await saveMutation(makeNote(book.id, entry.row.body_md, entry.row.highlight_id, row.id));
				notes = [...notes.filter((item) => item.id !== row.id), { ...entry.row, deleted_at: null }];
			} else {
				await saveMutation(makePageAnnotation(book.id, file.id, entry.row, entry.row));
				annotationVersion += 1;
				pageAnnotations = [...pageAnnotations.filter((item) => item.id !== row.id), { ...entry.row, deleted_at: null }];
			}
			return true;
		} catch (error) {
			reportActionError(error);
			return false;
		} finally {
			busy = false;
		}
	}

	async function writePageAnnotation(input: PageAnnotationInput, existing?: PageAnnotation) {
		if (!book || !file || format !== 'pdf' || busy) return false;
		annotationVersion += 1;
		const version = requestVersion;
		const previous = pageAnnotations;
		busy = true;
		actionError = '';
		try {
			const mutation = makePageAnnotation(book.id, file.id, input, existing);
			if (!('id' in mutation)) throw new Error('Page annotation ID is missing.');
			const now = new Date(mutation.updated_at).toISOString();
			const row: PageAnnotation = {
				...input, id: mutation.id, book_id: book.id, book_file_id: file.id,
				created_at: existing?.created_at ?? now, updated_at: now, deleted_at: null, rev: existing?.rev ?? 0
			};
			pageAnnotations = existing && pageAnnotations.some((item) => item.id === existing.id)
				? pageAnnotations.map((item) => item.id === existing.id ? row : item) : [...pageAnnotations, row];
			await saveMutation(mutation);
			return true;
		} catch (error) {
			if (version === requestVersion) {
				pageAnnotations = previous;
				reportActionError(error);
			}
			return false;
		} finally {
			busy = false;
		}
	}

	async function removePageAnnotation(row: PageAnnotation) {
		if (busy) return false;
		if (row.book_file_id !== file?.id || !pageAnnotations.some((item) => item.id === row.id)) {
			console.error('Rejected unavailable page annotation deletion');
			actionError = m['reader.error.save']();
			return false;
		}
		annotationVersion += 1;
		const version = requestVersion;
		const previous = pageAnnotations;
		busy = true;
		actionError = '';
		pageAnnotations = pageAnnotations.filter((item) => item.id !== row.id);
		try {
			await saveMutation(deletePageAnnotation(row.id));
			return true;
		} catch (error) {
			if (version === requestVersion) {
				pageAnnotations = previous;
				reportActionError(error);
			}
			return false;
		} finally {
			busy = false;
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
				selection: (next) => { if (version === requestVersion && (selectedFormat === 'pdf' || next)) selection = next; },
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
			const progress = state.progress;
			await restorePosition(currentReader, progress, fileId, selectedFormat);
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
		get pageAnnotations() { return pageAnnotations; },
		get otherPageAnnotations() { return otherPageAnnotations; },
		get bookmarks() { return bookmarks; },
		get location() { return location; },
		get selection() { return selection; },
		get orderedHighlights() { return orderedHighlights; },
		get bookNotes() { return bookNotes; },
		get availableBookmarks() { return availableBookmarks; },
		mount, dispose, beforeNavigate, setDraftGuard, registerDraftGuard, setViewSave, attach, turnPage, goToFraction, goToHighlight, removeHighlight, removeBookmark, jumpToBookmark, retryWrites, applySettings, saveSettings, addHighlight, saveNote,
		addPageAnnotation: (input: PageAnnotationInput) => writePageAnnotation(input),
		updatePageAnnotation: (row: PageAnnotation, patch: Partial<PageAnnotationInput>) => {
			const input = { ...row, ...patch };
			if (row.book_file_id !== file?.id || !pageAnnotations.some((item) => item.id === row.id) || !validatePageAnnotationInput(input)) {
				console.error('Rejected invalid page annotation update');
				actionError = m['reader.error.save']();
				return Promise.resolve(false);
			}
			return writePageAnnotation(input, row);
		},
		removePageAnnotation,
		restoreDeletedAnnotation,
		restorePageAnnotation: (row: PageAnnotation) => {
			if (row.book_id !== book?.id || row.book_file_id !== file?.id ||
				pageAnnotations.some((item) => item.id === row.id)) {
				console.error('Rejected unavailable page annotation restoration');
				actionError = m['reader.error.save']();
				return Promise.resolve(false);
			}
			return writePageAnnotation(row, row);
		},
		close: closeReader,
		retry: () => { const p = params(); return openBook(p.bookId, p.fileId, p.bookmarkId, p.highlightId); },
		updateHighlight: changeHighlight,
		deleteNote: removeNote,
		addBookmark: (input: { label: string; id?: string; at?: Relocation }) => saveBookmark({ id: input.id ?? uuidv7(), label: input.label, original: '', editing: false }, input.at ?? null),
		updateBookmark: (bookmark: Bookmark, input: { label: string }) => saveBookmark({ id: bookmark.id, label: input.label, original: bookmark.label, editing: true }),
		relocate
	};
}

export type ReaderController = ReturnType<typeof createReaderController>;
