import { listProviders } from '#lib/admin/api.js';
import { ApiError } from '#lib/api/client.js';
import { getBook } from '#lib/catalog/api.js';
import type { Book } from '#lib/catalog/types.js';
import * as m from '#lib/paraglide/messages.js';
import { fetchCoverPreview, lookupCandidates, saveMetadata } from '#lib/metadata/api.js';
import {
	buildManualPatch, copyCandidateField, createDraft, InvalidMetadataDraftError,
	metadataDirty, restoreField, type MetadataDraft
} from '#lib/metadata/editor.js';
import { candidateOffers, findCandidate, sameCandidate, selectCandidateValues, selectField } from '#lib/metadata/merge.js';
import { ObjectUrlSlot } from '#lib/metadata/object-url.js';
import { InvalidTagsError, normalizeTags } from '#lib/metadata/tags.js';
import {
	MERGE_FIELDS, type Candidate, type CandidateRef, type LookupQuery, type LookupResponse,
	type MergeField, type Selections
} from '#lib/metadata/types.js';

export type TermField = 'tags' | 'genres' | 'moods';

export const TERM_FIELDS: readonly TermField[] = ['tags', 'genres', 'moods'];

function isTermField(field: MergeField): field is TermField {
	return (TERM_FIELDS as readonly string[]).includes(field);
}

/** The search form prefilled from a book, Booklore-style. */
export function defaultQuery(book: Book): { isbn: string; title: string; author: string } {
	const isbn = book.identifiers.find((id) => id.scheme === 'isbn13')?.value ??
		book.identifiers.find((id) => id.scheme === 'isbn10')?.value ?? '';
	const authors = [...book.authors].sort((a, b) => a.position - b.position);
	const author = (authors.find((person) => person.role === 'author') ?? authors[0])?.name ?? '';
	return { isbn, title: book.title, author };
}

export function termValidationMessage(field: TermField, cause: InvalidTagsError): string {
	if (field === 'tags') {
		switch (cause.reason) {
			case 'duplicate': return m['metadata.tags.duplicate']();
			case 'limit': return m['metadata.tags.limit']();
			default: return m['metadata.tags.invalid']();
		}
	}
	switch (cause.reason) {
		case 'duplicate': return m['metadata.terms.duplicate']();
		case 'limit': return m['metadata.terms.limit']();
		default: return m['metadata.terms.invalid']();
	}
}

/**
 * Draft, provider lookup, selections and saving for the metadata tab. Both the
 * Edit and Search views share one instance so switching views keeps the draft.
 */
export class MetadataEditorState {
	// Assigned in the constructor; deriveds below only read them lazily.
	book = $state<Book>(null!);
	draft = $state<MetadataDraft>(null!);
	editing = $state(false);
	/** Text typed into a chip input but not yet added; it still counts as an edit. */
	pending = $state<Record<TermField, string>>({ tags: '', genres: '', moods: '' });
	error = $state('');
	forbidden = $state(false);
	lookup = $state<LookupResponse | null>(null);
	lookupPending = $state(false);
	lookupError = $state('');
	activeSource = $state('');
	alternatives = $state<Record<string, string>>({});
	selections = $state<Selections>({});
	saving = $state(false);
	recovering = $state(false);
	recoveryBlocked = $state(false);
	notice = $state('');
	saveError = $state('');
	previewUrl = $state<string | null>(null);
	previewPending = $state(false);
	previewError = $state('');
	chosenCoverUrl = $state<string | null>(null);
	chosenCoverPending = $state(false);
	chosenCoverError = $state('');
	/** The Search view form, prefilled from the book. */
	search = $state({ isbn: '', title: '', author: '' });
	/** Enabled providers known to the client, in priority order. */
	providers = $state<string[]>([]);
	/** Providers the admin unchecked; none means every enabled provider is searched. */
	excludedProviders = $state<string[]>([]);
	searchError = $state('');

	readonly sources = $derived(this.lookup?.providers.filter((provider) => provider.candidates.length > 0) ?? []);
	readonly source = $derived(this.sources.find((provider) => provider.provider === this.activeSource) ?? this.sources[0]);
	readonly candidate: Candidate | undefined = $derived(
		this.source?.candidates.find((item) => item.reference === this.alternatives[this.source!.provider]) ?? this.source?.candidates[0]
	);
	readonly candidateTotal = $derived(this.sources.reduce((count, provider) => count + provider.candidates.length, 0));
	readonly partialFailure = $derived(this.lookup?.providers.some((provider) => provider.error !== null) ?? false);
	readonly dirty = $derived(
		TERM_FIELDS.some((field) => this.pending[field] !== '') || metadataDirty(this.book, this.draft, this.selections)
	);
	readonly busy = $derived(this.saving || this.recovering || this.recoveryBlocked);
	readonly providerChoices = $derived(
		this.providers.length ? this.providers : (this.lookup?.providers.map((provider) => provider.provider) ?? [])
	);

	#version = 0;
	#lastQuery: LookupQuery | undefined;
	#lookupController: AbortController | null = null;
	#previewController: AbortController | null = null;
	#chosenCoverController: AbortController | null = null;
	readonly #preview = new ObjectUrlSlot();
	readonly #chosenCover = new ObjectUrlSlot();
	readonly #onBook: (book: Book) => void;
	#editSnapshot: {
		draft: MetadataDraft;
		pending: Record<TermField, string>;
		selections: Selections;
	} | null = null;

	constructor(book: Book, onBook: (book: Book) => void) {
		this.book = book;
		this.draft = createDraft(book);
		this.search = defaultQuery(book);
		this.#onBook = onBook;
	}

	/** Loads the enabled providers for the search form; failures fall back to lookup results. */
	async loadProviders(signal?: AbortSignal) {
		try {
			const settings = await listProviders(signal);
			this.providers = settings.filter((item) => item.enabled)
				.sort((a, b) => a.priority - b.priority).map((item) => item.provider);
		} catch {
			// Providers from the next lookup response are used instead.
		}
	}

	toggleProvider(provider: string, checked: boolean) {
		this.excludedProviders = checked
			? this.excludedProviders.filter((item) => item !== provider)
			: [...new Set([...this.excludedProviders, provider])];
		this.searchError = '';
	}

	/** Runs the Search view query; an empty ISBN and title let the server derive the query from the book. */
	async searchProviders() {
		const choices = this.providerChoices;
		const chosen = choices.filter((provider) => !this.excludedProviders.includes(provider));
		if (choices.length && !chosen.length) {
			this.searchError = m['metadata.search.no_provider']();
			return;
		}
		this.searchError = '';
		const restricted = chosen.length < choices.length;
		const { isbn, title, author } = this.search;
		if (isbn.trim() === '' && title.trim() === '') {
			await this.runLookup(undefined);
			return;
		}
		await this.runLookup({ isbn, title, author, ...(restricted ? { providers: chosen } : {}) });
	}

	destroy() {
		this.#version += 1;
		this.#lookupController?.abort();
		this.clearCovers();
	}

	/** Adopts a book refreshed elsewhere; only safe while nothing is edited. */
	adopt(book: Book) {
		if (book === this.book || this.editing || this.dirty || this.busy || this.lookupPending) return;
		this.book = book;
		this.draft = createDraft(book);
		this.search = defaultQuery(book);
	}

	clearCovers() {
		this.#previewController?.abort();
		this.#chosenCoverController?.abort();
		this.#previewController = null;
		this.#chosenCoverController = null;
		this.#preview.clear();
		this.#chosenCover.clear();
		this.previewUrl = null;
		this.chosenCoverUrl = null;
		this.previewPending = false;
		this.chosenCoverPending = false;
		this.previewError = '';
		this.chosenCoverError = '';
	}

	#handleAccessError(cause: unknown): boolean {
		if (!(cause instanceof ApiError)) return false;
		if (cause.status === 401) this.error = m['metadata.edit.session_expired']();
		else if (cause.status === 403) this.forbidden = true;
		else if (cause.status === 404) this.error = m['catalog.error.not_found']();
		else return false;
		this.#version += 1;
		this.#lookupController?.abort();
		this.#lookupController = null;
		this.lookupPending = false;
		this.clearCovers();
		return true;
	}

	#clearMessages() {
		this.notice = '';
		this.saveError = '';
	}

	/** Searches providers; without a query the server derives one from the book. */
	async runLookup(query?: LookupQuery, duringRecovery = false) {
		if (this.lookupPending || (this.busy && !duringRecovery)) return;
		if (!duringRecovery) this.#lastQuery = query;
		const request = this.#version;
		const controller = new AbortController();
		this.#lookupController = controller;
		this.lookupPending = true;
		this.lookupError = '';
		try {
			const result = await lookupCandidates(this.book.id, this.#lastQuery, controller.signal);
			if (request !== this.#version || controller.signal.aborted) return;
			// Keep provenance only when the reference still exists in the fresh cache.
			if (Object.keys(this.selections).length) this.notice = m['metadata.lookup.draft_retained']();
			const next: Selections = {};
			let draft = this.draft;
			for (const field of MERGE_FIELDS) {
				const ref = this.selections[field];
				if (!ref) continue;
				const fresh = findCandidate(result.providers, ref);
				if (fresh && candidateOffers(fresh, field)) {
					draft = copyCandidateField(draft, fresh, field);
					next[field] = ref;
				} else {
					draft = restoreField(draft, this.book, field);
				}
			}
			this.draft = draft;
			this.selections = next;
			this.lookup = result;
			if (!result.providers.some((provider) => provider.provider === this.activeSource && provider.candidates.length)) {
				this.activeSource = result.providers.find((provider) => provider.candidates.length)?.provider ?? '';
			}
		} catch (cause) {
			if (request !== this.#version || controller.signal.aborted) return;
			if (!this.#handleAccessError(cause)) this.lookupError = m['metadata.lookup.failure']();
		} finally {
			if (this.#lookupController === controller) {
				this.#lookupController = null;
				this.lookupPending = false;
			}
		}
	}

	async recoverFromConflict() {
		if (this.recovering) return;
		const request = this.#version;
		const selectedFields = MERGE_FIELDS.filter((field) => this.selections[field]);
		this.recovering = true;
		this.#lookupController?.abort();
		this.#lookupController = null;
		this.lookupPending = false;
		this.#previewController?.abort();
		this.#chosenCoverController?.abort();
		this.saveError = m['metadata.save.conflict']();
		try {
			const updated = await getBook(this.book.id);
			if (request !== this.#version) return;
			// Provider copies must not become manual edits when stale references are cleared.
			let draft = this.draft;
			for (const field of selectedFields) draft = restoreField(draft, updated, field);
			this.draft = draft;
			this.book = updated;
			this.selections = {};
			this.lookup = null;
			this.recoveryBlocked = false;
			this.clearCovers();
			this.#onBook(updated);
			await this.runLookup(undefined, true);
		} catch (cause) {
			if (request !== this.#version) return;
			if (!this.#handleAccessError(cause)) {
				this.recoveryBlocked = true;
				this.saveError = m['metadata.save.conflict_refresh_failure']();
			}
		} finally {
			if (request === this.#version) this.recovering = false;
		}
	}

	async loadCover(ref: CandidateRef | undefined, requestKey: string | undefined, chosen: boolean) {
		const slot = chosen ? this.#chosenCover : this.#preview;
		if (chosen) {
			this.#chosenCoverController?.abort();
			this.#chosenCoverController = null;
			this.chosenCoverUrl = null;
			this.chosenCoverPending = false;
			this.chosenCoverError = '';
		} else {
			this.#previewController?.abort();
			this.#previewController = null;
			this.previewUrl = null;
			this.previewPending = false;
			this.previewError = '';
		}
		slot.clear();
		if (!ref || !requestKey || this.recoveryBlocked) return;
		const request = this.#version;
		const controller = new AbortController();
		if (chosen) {
			this.#chosenCoverController = controller;
			this.chosenCoverPending = true;
		} else {
			this.#previewController = controller;
			this.previewPending = true;
		}
		const fail = () => {
			if (chosen) this.chosenCoverError = m['metadata.cover.preview_failure']();
			else this.previewError = m['metadata.cover.preview_failure']();
		};
		try {
			const blob = await fetchCoverPreview(this.book.id, requestKey, ref, controller.signal);
			if (request !== this.#version || controller.signal.aborted || this.lookup?.request_key !== requestKey) return;
			const url = slot.set(blob);
			if (chosen) this.chosenCoverUrl = url;
			else this.previewUrl = url;
		} catch (cause) {
			if (request !== this.#version || controller.signal.aborted || this.lookup?.request_key !== requestKey) return;
			if (cause instanceof ApiError && cause.status === 409) {
				if (this.saving || this.recovering) fail();
				else await this.recoverFromConflict();
				return;
			}
			if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403) && this.#handleAccessError(cause)) return;
			fail();
		} finally {
			if (chosen && this.#chosenCoverController === controller) {
				this.#chosenCoverController = null;
				this.chosenCoverPending = false;
			} else if (!chosen && this.#previewController === controller) {
				this.#previewController = null;
				this.previewPending = false;
			}
		}
	}

	/** A manual edit drops any provider selection for the field. */
	edited(field: MergeField) {
		if (this.busy) return;
		this.selections = selectField(this.selections, field, null);
		this.#clearMessages();
	}

	setDraft(draft: MetadataDraft, field: MergeField) {
		if (this.busy) return;
		this.draft = draft;
		this.edited(field);
	}

	useFound(field: MergeField) {
		const candidate = this.candidate;
		if (!candidate || this.busy || this.lookupPending || !candidateOffers(candidate, field)) return;
		this.draft = copyCandidateField(this.draft, candidate, field);
		this.selections = selectField(this.selections, field, candidate);
		if (isTermField(field)) this.pending[field] = '';
		this.#clearMessages();
	}

	useAll() {
		const candidate = this.candidate;
		if (!candidate || this.busy || this.lookupPending) return;
		const next = selectCandidateValues(this.selections, candidate);
		let draft = this.draft;
		for (const field of MERGE_FIELDS) {
			if (sameCandidate(next[field], candidate)) {
				draft = copyCandidateField(draft, candidate, field);
				if (isTermField(field)) this.pending[field] = '';
			}
		}
		this.draft = draft;
		this.selections = next;
		this.#clearMessages();
	}

	restore(field: MergeField) {
		if (this.busy) return;
		this.draft = restoreField(this.draft, this.book, field);
		if (isTermField(field)) this.pending[field] = '';
		this.edited(field);
	}

	restoreAll() {
		if (this.busy) return;
		const snapshot = this.#editSnapshot;
		this.draft = snapshot ? structuredClone(snapshot.draft) : createDraft(this.book);
		this.selections = snapshot ? structuredClone(snapshot.selections) : {};
		this.pending = snapshot ? { ...snapshot.pending } : { tags: '', genres: '', moods: '' };
		this.#clearMessages();
	}

	beginEdit() {
		if (this.editing || this.busy || this.lookupPending) return;
		this.#editSnapshot = {
			draft: $state.snapshot(this.draft),
			pending: $state.snapshot(this.pending),
			selections: $state.snapshot(this.selections)
		};
		this.editing = true;
		this.#clearMessages();
	}

	/** Adds the pending chip text; an invalid name is reported and nothing changes. */
	addTerm(field: TermField) {
		if (this.busy) return;
		try {
			const values = normalizeTags([...this.draft[field], this.pending[field]]);
			this.draft = { ...this.draft, [field]: values };
			this.pending[field] = '';
			this.edited(field);
		} catch (cause) {
			if (!(cause instanceof InvalidTagsError)) throw cause;
			this.saveError = termValidationMessage(field, cause);
		}
	}

	removeTerm(field: TermField, index: number) {
		this.setDraft({ ...this.draft, [field]: this.draft[field].filter((_, position) => position !== index) }, field);
	}

	async save(): Promise<boolean> {
		if (this.busy || this.lookupPending || !this.dirty) return false;
		this.#clearMessages();
		const request = this.#version;
		let failedField: TermField = 'tags';
		try {
			const pendingDraft = $state.snapshot(this.draft) as MetadataDraft;
			const pendingSelections = $state.snapshot(this.selections) as Selections;
			for (const field of TERM_FIELDS) {
				if (this.pending[field] === '') continue;
				failedField = field;
				pendingDraft[field] = normalizeTags([...pendingDraft[field], this.pending[field]]);
				delete pendingSelections[field];
			}
			const patch = buildManualPatch(this.book, pendingDraft, pendingSelections);
			this.saving = true;
			const updated = await saveMetadata(this.book.id, patch, this.lookup?.request_key ?? null, pendingSelections);
			if (request !== this.#version) return false;
			this.book = updated;
			this.draft = createDraft(updated);
			this.pending = { tags: '', genres: '', moods: '' };
			this.selections = {};
			this.editing = false;
			this.#editSnapshot = null;
			this.notice = m['metadata.save.success']();
			this.#onBook(updated);
			return true;
		} catch (cause) {
			if (request !== this.#version) return false;
			if (cause instanceof InvalidTagsError) this.saveError = termValidationMessage(failedField, cause);
			else if (cause instanceof InvalidMetadataDraftError) this.saveError = m['metadata.save.invalid_draft']();
			else if (cause instanceof ApiError && cause.status === 409) await this.recoverFromConflict();
			else if (!this.#handleAccessError(cause)) {
				this.saveError = cause instanceof ApiError && cause.status === 400
					? m['metadata.save.rejected']() : m['metadata.save.failure']();
			}
		} finally {
			if (request === this.#version) this.saving = false;
		}
		return false;
	}
}
