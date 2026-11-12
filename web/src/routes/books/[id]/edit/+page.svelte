<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { page } from '$app/state';
	import { ApiError } from '#lib/api/client.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getBook } from '#lib/catalog/api.js';
	import { catalogErrorMessage } from '#lib/catalog/errors.js';
	import type { Book } from '#lib/catalog/types.js';
	import { getSessionViewer } from '#lib/shelves/api.js';
	import { isAdministrator } from '#lib/shelves/form.js';
	import { fetchCoverPreview, lookupCandidates, saveMetadata } from '#lib/metadata/api.js';
	import {
		buildManualPatch, copyCandidateField, createDraft, InvalidMetadataDraftError,
		metadataDirty, restoreField, type MetadataDraft
	} from '#lib/metadata/editor.js';
	import {
		candidateKey, candidateOffers, candidateValues, findCandidate, sameCandidate,
		selectCandidateValues, selectField
	} from '#lib/metadata/merge.js';
	import { ObjectUrlSlot } from '#lib/metadata/object-url.js';
	import { InvalidTagsError, normalizeTags } from '#lib/metadata/tags.js';
	import {
		MERGE_FIELDS, type Candidate, type CandidateRef, type LookupResponse,
		type MergeField, type Selections
	} from '#lib/metadata/types.js';

	let book = $state<Book | null>(null);
	let draft = $state<MetadataDraft | null>(null);
	let loading = $state(true);
	let error = $state('');
	let forbidden = $state(false);
	let lookup = $state<LookupResponse | null>(null);
	let lookupPending = $state(false);
	let lookupError = $state('');
	let activeSource = $state('');
	let alternatives = $state<Record<string, string>>({});
	let selections = $state<Selections>({});
	let saving = $state(false);
	let recovering = $state(false);
	let recoveryBlocked = $state(false);
	let notice = $state('');
	let saveError = $state('');
	let newTag = $state('');
	let previewUrl = $state<string | null>(null);
	let previewPending = $state(false);
	let previewError = $state('');
	let chosenCoverUrl = $state<string | null>(null);
	let chosenCoverPending = $state(false);
	let chosenCoverError = $state('');
	let version = 0;
	let lookupController: AbortController | null = null;
	let previewController: AbortController | null = null;
	let chosenCoverController: AbortController | null = null;
	const preview = new ObjectUrlSlot();
	const chosenCover = new ObjectUrlSlot();

	const fieldLabels: Record<MergeField, () => string> = {
		title: m['metadata.field.title'],
		subtitle: m['metadata.field.subtitle'],
		authors: m['metadata.field.authors'],
		description: m['metadata.field.description'],
		language: m['metadata.field.language'],
		publisher: m['metadata.field.publisher'],
		published_date: m['metadata.field.published_date'],
		page_count: m['metadata.field.page_count'],
		series: m['metadata.field.series'],
		tags: m['metadata.field.tags'],
		identifiers: m['metadata.field.identifiers'],
		cover: m['metadata.field.cover']
	};
	const sources = $derived(lookup?.providers.filter((provider) => provider.candidates.length > 0) ?? []);
	const source = $derived(sources.find((provider) => provider.provider === activeSource) ?? sources[0]);
	const candidate = $derived(source?.candidates.find((item) => item.reference === alternatives[source.provider]) ?? source?.candidates[0]);
	const candidateTotal = $derived(sources.reduce((count, provider) => count + provider.candidates.length, 0));
	const partialFailure = $derived(lookup?.providers.some((provider) => provider.error !== null) ?? false);
	const dirty = $derived(!!book && !!draft && (newTag !== '' || metadataDirty(book, draft, selections)));
	const busy = $derived(saving || recovering || recoveryBlocked);

	$effect(() => {
		const id = page.params.id ?? '';
		untrack(() => { void load(id); });
	});

	$effect(() => {
		const ref = candidate;
		const requestKey = lookup?.request_key;
		untrack(() => { void loadCover(ref?.cover_url ? ref : undefined, requestKey, false); });
	});

	$effect(() => {
		const ref = selections.cover;
		const requestKey = lookup?.request_key;
		untrack(() => { void loadCover(ref, requestKey, true); });
	});

	onDestroy(() => {
		version += 1;
		lookupController?.abort();
		clearCovers();
	});

	function clearCovers() {
		previewController?.abort();
		chosenCoverController?.abort();
		previewController = null;
		chosenCoverController = null;
		preview.clear();
		chosenCover.clear();
		previewUrl = null;
		chosenCoverUrl = null;
		previewPending = false;
		chosenCoverPending = false;
		previewError = '';
		chosenCoverError = '';
	}

	function reset() {
		lookupController?.abort();
		lookupController = null;
		clearCovers();
		lookup = null;
		lookupPending = false;
		lookupError = '';
		activeSource = '';
		alternatives = {};
		selections = {};
		saving = false;
		recovering = false;
		recoveryBlocked = false;
		notice = '';
		saveError = '';
	}

	function roleLabel(role: string): string {
		switch (role) {
			case 'author': return m['catalog.book.role.author']();
			case 'translator': return m['catalog.book.role.translator']();
			case 'editor': return m['catalog.book.role.editor']();
			case 'illustrator': return m['catalog.book.role.illustrator']();
			default: return role;
		}
	}

	function providerErrorCode(code: string): string {
		return /^[a-z0-9_-]{1,64}$/i.test(code) ? code : 'unknown';
	}

	function handleAccessError(cause: unknown): boolean {
		if (!(cause instanceof ApiError)) return false;
		if (cause.status === 401) error = m['metadata.edit.session_expired']();
		else if (cause.status === 403) forbidden = true;
		else if (cause.status === 404) error = m['catalog.error.not_found']();
		else return false;
		book = null;
		draft = null;
		reset();
		return true;
	}

	async function load(id: string) {
		const request = ++version;
		reset();
		book = null;
		draft = null;
		newTag = '';
		error = '';
		forbidden = false;
		loading = true;
		const bookId = Number(id);
		if (!Number.isSafeInteger(bookId) || bookId < 1) {
			error = m['catalog.error.not_found']();
			loading = false;
			return;
		}
		try {
			const [viewer, loaded] = await Promise.all([getSessionViewer(), getBook(bookId)]);
			if (request !== version) return;
			if (!isAdministrator(viewer)) {
				forbidden = true;
				return;
			}
			book = loaded;
			draft = createDraft(loaded);
		} catch (cause) {
			if (request !== version) return;
			if (!handleAccessError(cause)) {
				error = catalogErrorMessage(cause, {
					api: m['catalog.error.api'](),
					connection: m['catalog.error.connection'](),
					notFound: m['catalog.error.not_found']()
				});
			}
		} finally {
			if (request === version) loading = false;
		}
	}

	async function runLookup(duringRecovery = false) {
		if (!book || !draft || lookupPending || (busy && !duringRecovery)) return;
		const request = version;
		const controller = new AbortController();
		lookupController = controller;
		lookupPending = true;
		lookupError = '';
		try {
			const result = await lookupCandidates(book.id, controller.signal);
			if (request !== version || controller.signal.aborted) return;
			// Keep provenance only when the reference still exists in the fresh cache.
			if (Object.keys(selections).length) notice = m['metadata.lookup.draft_retained']();
			const next: Selections = {};
			for (const field of MERGE_FIELDS) {
				const ref = selections[field];
				if (!ref) continue;
				const fresh = findCandidate(result.providers, ref);
				if (fresh && candidateOffers(fresh, field)) {
					draft = copyCandidateField(draft, fresh, field);
					next[field] = ref;
				} else {
					draft = restoreField(draft, book, field);
				}
			}
			selections = next;
			lookup = result;
			if (!result.providers.some((provider) => provider.provider === activeSource && provider.candidates.length)) {
				activeSource = result.providers.find((provider) => provider.candidates.length)?.provider ?? '';
			}
		} catch (cause) {
			if (request !== version || controller.signal.aborted) return;
			if (!handleAccessError(cause)) lookupError = m['metadata.lookup.failure']();
		} finally {
			if (lookupController === controller) {
				lookupController = null;
				lookupPending = false;
			}
		}
	}

	async function recoverFromConflict() {
		if (!book || !draft || recovering) return;
		const request = version;
		const bookId = book.id;
		const selectedFields = MERGE_FIELDS.filter((field) => selections[field]);
		recovering = true;
		lookupController?.abort();
		lookupController = null;
		lookupPending = false;
		previewController?.abort();
		chosenCoverController?.abort();
		saveError = m['metadata.save.conflict']();
		try {
			const updated = await getBook(bookId);
			if (request !== version) return;
			// Provider copies must not become manual edits when stale references are cleared.
			for (const field of selectedFields) draft = restoreField(draft, updated, field);
			book = updated;
			selections = {};
			lookup = null;
			recoveryBlocked = false;
			clearCovers();
			await runLookup(true);
		} catch (cause) {
			if (request !== version) return;
			if (!handleAccessError(cause)) {
				recoveryBlocked = true;
				saveError = m['metadata.save.conflict_refresh_failure']();
			}
		} finally {
			if (request === version) recovering = false;
		}
	}

	async function loadCover(ref: CandidateRef | undefined, requestKey: string | undefined, chosen: boolean) {
		const slot = chosen ? chosenCover : preview;
		if (chosen) {
			chosenCoverController?.abort();
			chosenCoverController = null;
			chosenCoverUrl = null;
			chosenCoverPending = false;
			chosenCoverError = '';
		} else {
			previewController?.abort();
			previewController = null;
			previewUrl = null;
			previewPending = false;
			previewError = '';
		}
		slot.clear();
		if (!book || !ref || !requestKey || recoveryBlocked) return;
		const request = version;
		const controller = new AbortController();
		if (chosen) {
			chosenCoverController = controller;
			chosenCoverPending = true;
		} else {
			previewController = controller;
			previewPending = true;
		}
		try {
			const blob = await fetchCoverPreview(book.id, requestKey, ref, controller.signal);
			if (request !== version || controller.signal.aborted || lookup?.request_key !== requestKey) return;
			const url = slot.set(blob);
			if (chosen) chosenCoverUrl = url;
			else previewUrl = url;
		} catch (cause) {
			if (request !== version || controller.signal.aborted || lookup?.request_key !== requestKey) return;
			if (cause instanceof ApiError && cause.status === 409) {
				if (saving || recovering) {
					if (chosen) chosenCoverError = m['metadata.cover.preview_failure']();
					else previewError = m['metadata.cover.preview_failure']();
					return;
				}
				await recoverFromConflict();
				return;
			}
			if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403) && handleAccessError(cause)) return;
			if (chosen) chosenCoverError = m['metadata.cover.preview_failure']();
			else previewError = m['metadata.cover.preview_failure']();
		} finally {
			if (chosen && chosenCoverController === controller) {
				chosenCoverController = null;
				chosenCoverPending = false;
			} else if (!chosen && previewController === controller) {
				previewController = null;
				previewPending = false;
			}
		}
	}

	function edited(field: MergeField) {
		if (busy) return;
		selections = selectField(selections, field, null);
		notice = '';
		saveError = '';
	}

	function useFound(field: MergeField) {
		if (!draft || !candidate || busy || lookupPending) return;
		draft = copyCandidateField(draft, candidate, field);
		selections = selectField(selections, field, candidate);
		if (field === 'tags') newTag = '';
		notice = '';
		saveError = '';
	}

	function useAll() {
		if (!draft || !candidate || busy || lookupPending) return;
		const next = selectCandidateValues(selections, candidate);
		for (const field of MERGE_FIELDS) {
			if (sameCandidate(next[field], candidate)) {
				draft = copyCandidateField(draft, candidate, field);
				if (field === 'tags') newTag = '';
			}
		}
		selections = next;
		notice = '';
		saveError = '';
	}

	function restore(field: MergeField) {
		if (!draft || !book || busy) return;
		draft = restoreField(draft, book, field);
		if (field === 'tags') newTag = '';
		edited(field);
	}

	function restoreAll() {
		if (!book || busy) return;
		draft = createDraft(book);
		selections = {};
		newTag = '';
		notice = '';
		saveError = '';
	}

	function tagValidationMessage(cause: InvalidTagsError): string {
		switch (cause.reason) {
			case 'duplicate': return m['metadata.tags.duplicate']();
			case 'limit': return m['metadata.tags.limit']();
			default: return m['metadata.tags.invalid']();
		}
	}

	function addTag() {
		if (!draft || busy) return;
		try {
			const tags = normalizeTags([...draft.tags, newTag]);
			draft = { ...draft, tags };
			newTag = '';
			edited('tags');
		} catch (cause) {
			if (!(cause instanceof InvalidTagsError)) throw cause;
			saveError = tagValidationMessage(cause);
		}
	}

	function movePerson(index: number, offset: number) {
		if (!draft || busy) return;
		const authors = [...draft.authors];
		const target = index + offset;
		if (target < 0 || target >= authors.length) return;
		[authors[index], authors[target]] = [authors[target], authors[index]];
		draft = { ...draft, authors };
		edited('authors');
	}

	function sourceKeydown(event: KeyboardEvent, index: number) {
		let target: number;
		switch (event.key) {
			case 'ArrowRight': target = (index + 1) % sources.length; break;
			case 'ArrowLeft': target = (index - 1 + sources.length) % sources.length; break;
			case 'Home': target = 0; break;
			case 'End': target = sources.length - 1; break;
			default: return;
		}
		event.preventDefault();
		if (busy || lookupPending) return;
		activeSource = sources[target].provider;
		const tablist = event.currentTarget instanceof HTMLElement ? event.currentTarget.parentElement : null;
		(tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target])?.focus();
	}

	async function save() {
		if (!book || !draft || busy || lookupPending || !dirty) return;
		notice = '';
		saveError = '';
		const request = version;
		try {
			const pendingDraft = newTag === '' ? $state.snapshot(draft) : {
				...$state.snapshot(draft), tags: normalizeTags([...draft.tags, newTag])
			};
			const pendingSelections = $state.snapshot(selections);
			if (newTag !== '') delete pendingSelections.tags;
			const patch = buildManualPatch(book, pendingDraft, pendingSelections);
			saving = true;
			const updated = await saveMetadata(book.id, patch, lookup?.request_key ?? null, pendingSelections);
			if (request !== version) return;
			book = updated;
			draft = createDraft(updated);
			newTag = '';
			selections = {};
			notice = m['metadata.save.success']();
		} catch (cause) {
			if (request !== version) return;
			if (cause instanceof InvalidTagsError) saveError = tagValidationMessage(cause);
			else if (cause instanceof InvalidMetadataDraftError) saveError = m['metadata.save.invalid_draft']();
			else if (cause instanceof ApiError && cause.status === 409) await recoverFromConflict();
			else if (!handleAccessError(cause)) {
				saveError = cause instanceof ApiError && cause.status === 400
					? m['metadata.save.rejected']() : m['metadata.save.failure']();
			}
		} finally {
			if (request === version) saving = false;
		}
	}
</script>

{#snippet values(items: string[], field: MergeField)}
	{#if items.length === 0}
		<span class="text-slate-500">{m['metadata.field.empty']()}</span>
	{:else if field === 'description'}
		<span class="block max-h-56 overflow-y-auto whitespace-pre-wrap">{items[0]}</span>
	{:else if items.length === 1}
		<span>{items[0]}</span>
	{:else}
		<ol class="list-inside list-decimal space-y-1">
			{#each items as item, index (index)}<li>{item}</li>{/each}
		</ol>
	{/if}
{/snippet}

{#if error}
	<div class="space-y-4" role="alert">
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{error}</p>
		<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => load(page.params.id ?? '')}>{m['catalog.retry']()}</button>
	</div>
{:else if forbidden}
	<div class="space-y-4">
		<p class="rounded-md border border-amber-200 bg-amber-50 p-4 text-amber-900" role="alert">{m['metadata.edit.forbidden']()}</p>
		<a class="underline underline-offset-4 focus-visible:outline-2" href={`/books/${page.params.id ?? ''}`}>{m['metadata.edit.back']()}</a>
	</div>
{:else if loading}
	<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
{:else if book && draft}
	<article class="min-w-0 space-y-6">
		<header class="space-y-3">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<a class="text-sm text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2" href={`/books/${book.id}`}>{m['metadata.edit.back']()}</a>
				<button type="button" class="primary-button" disabled={lookupPending || busy} onclick={() => runLookup()}>
					{m['metadata.lookup.start']()}
				</button>
			</div>
			<h1 class="break-words text-3xl font-semibold tracking-tight">{m['metadata.edit.title']({ title: book.title })}</h1>
			<p class="text-slate-600">{m['metadata.edit.description']()}</p>
		</header>

		<div aria-live="polite" role="status" class="space-y-2 text-sm">
			{#if lookupPending}<p>{m['metadata.lookup.loading']()}</p>
			{:else if lookup && !candidateTotal}<p>{m['metadata.lookup.empty']()}</p>
			{:else if lookup}<p>{m['metadata.lookup.ready']({ count: candidateTotal })}</p>{/if}
			{#if notice}<p class="rounded-md bg-green-50 p-3 text-green-800">{notice}</p>{/if}
		</div>
		{#if lookupError}<p class="rounded-md bg-red-50 p-3 text-red-800" role="alert">{lookupError}</p>{/if}
		{#if partialFailure}<p class="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{m['metadata.lookup.partial']()}</p>{/if}
		{#each lookup?.providers.filter((provider) => provider.error) ?? [] as provider (provider.provider)}
			<p class="text-sm text-amber-900">{m['metadata.provider.failed']({ provider: provider.provider, code: providerErrorCode(provider.error!.code) })}</p>
		{/each}

		<form aria-label={m['metadata.form.name']()} class="metadata-form card" class:comparing={!!candidate} onsubmit={(event) => { event.preventDefault(); void save(); }}>
			{#if sources.length && source}
				<div class="source-controls">
					<div role="tablist" aria-label={m['metadata.lookup.heading']()} class="source-tabs">
						{#each sources as provider, index (provider.provider)}
							<button type="button" role="tab" id={`source-tab-${index}`} aria-controls={`source-panel-${index}`}
								aria-selected={source.provider === provider.provider} tabindex={source.provider === provider.provider ? 0 : -1}
								disabled={busy || lookupPending} onclick={() => { activeSource = provider.provider; }}
								onkeydown={(event) => sourceKeydown(event, index)}>{provider.provider}</button>
						{/each}
					</div>
					{#each sources as provider, index (provider.provider)}
						<div role="tabpanel" id={`source-panel-${index}`} aria-labelledby={`source-tab-${index}`} hidden={source.provider !== provider.provider}>
							{#if source.provider === provider.provider}
								{#if provider.candidates.length > 1 && candidate}
									<label for="candidate-alternative">{m['metadata.candidate.alternative']()}</label>
									<select id="candidate-alternative" value={candidate.reference} disabled={busy || lookupPending}
										onchange={(event) => { alternatives = { ...alternatives, [provider.provider]: event.currentTarget.value }; }}>
										{#each provider.candidates as item (candidateKey(item))}
											<option value={item.reference}>{item.title}</option>
										{/each}
									</select>
								{:else if candidate}
									<p class="break-words text-sm text-slate-600">{candidate.title}</p>
								{/if}
							{/if}
						</div>
					{/each}
					<button type="button" class="secondary-button" disabled={busy || lookupPending || !candidate} onclick={useAll}>{m['metadata.candidate.use_available']()}</button>
				</div>
			{/if}
			{#if candidate}
				<div class="comparison-heading">
					<span>{m['metadata.column.draft']()}</span><span></span>
					<span>{m['metadata.column.found']()}</span>
				</div>
			{/if}
			{#each MERGE_FIELDS as field (field)}
				<fieldset class="metadata-row" data-field={field} disabled={busy}>
					<legend>{fieldLabels[field]()}</legend>
					<div class="comparison-grid">
						<div class="draft-value">
							{#if field === 'authors'}
								{#each draft.authors as person, index (index)}
									<div class="array-entry">
										<div>
											<label for={`person-name-${index}`}>{m['metadata.person.name']({ number: index + 1 })}</label>
											<input id={`person-name-${index}`} value={person.name} oninput={(event) => { if (draft) draft.authors[index] = { ...person, name: event.currentTarget.value }; edited('authors'); }} />
										</div>
										<div>
											<label for={`person-role-${index}`}>{m['metadata.person.role']({ number: index + 1 })}</label>
											<select id={`person-role-${index}`} value={person.role} onchange={(event) => { if (draft) draft.authors[index] = { ...person, role: event.currentTarget.value }; edited('authors'); }}>
												{#each ['author', 'translator', 'editor', 'illustrator'] as role}<option value={role}>{roleLabel(role)}</option>{/each}
												{#if !['author', 'translator', 'editor', 'illustrator'].includes(person.role)}<option value={person.role}>{person.role}</option>{/if}
											</select>
										</div>
										<div class="entry-actions">
											<button type="button" class="secondary-button" aria-label={m['metadata.person.up']({ number: index + 1 })} disabled={index === 0} onclick={() => movePerson(index, -1)}>↑</button>
											<button type="button" class="secondary-button" aria-label={m['metadata.person.down']({ number: index + 1 })} disabled={index === draft.authors.length - 1} onclick={() => movePerson(index, 1)}>↓</button>
											<button type="button" class="secondary-button" aria-label={m['metadata.person.remove']({ number: index + 1 })} onclick={() => { if (draft) draft.authors = draft.authors.filter((_, position) => position !== index); edited('authors'); }}>{m['metadata.tags.remove']()}</button>
										</div>
									</div>
								{/each}
								<button type="button" class="secondary-button" onclick={() => { if (draft) draft.authors = [...draft.authors, { name: '', role: 'author' }]; edited('authors'); }}>{m['metadata.person.add']()}</button>
							{:else if field === 'tags'}
								{#each draft.tags as tag, index (index)}
									<div class="tag-entry">
										<label class="sr-only" for={`tag-${index}`}>{m['metadata.tags.name']({ number: index + 1 })}</label>
										<input id={`tag-${index}`} value={tag} oninput={(event) => { if (draft) draft.tags[index] = event.currentTarget.value; edited('tags'); }} />
										<button type="button" class="secondary-button" aria-label={m['metadata.tags.remove_named']({ name: tag })} onclick={() => { if (draft) draft.tags = draft.tags.filter((_, position) => position !== index); edited('tags'); }}>{m['metadata.tags.remove']()}</button>
									</div>
								{/each}
								{#if !draft.tags.length}<p class="text-sm text-slate-500">{m['metadata.tags.empty']()}</p>{/if}
								<div>
									<label for="new-tag">{m['metadata.tags.new']()}</label>
									<div class="tag-entry">
										<input id="new-tag" bind:value={newTag} oninput={() => edited('tags')} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } }} />
										<button type="button" class="secondary-button" onclick={addTag}>{m['metadata.tags.add']()}</button>
									</div>
								</div>
							{:else if field === 'identifiers'}
								{#each draft.identifiers as identifier, index (index)}
									<div class="array-entry">
										<div>
											<label for={`identifier-scheme-${index}`}>{m['metadata.identifier.scheme']({ number: index + 1 })}</label>
											<input id={`identifier-scheme-${index}`} value={identifier.scheme} oninput={(event) => { if (draft) draft.identifiers[index] = { ...identifier, scheme: event.currentTarget.value }; edited('identifiers'); }} />
										</div>
										<div>
											<label for={`identifier-value-${index}`}>{m['metadata.identifier.value']({ number: index + 1 })}</label>
											<input id={`identifier-value-${index}`} value={identifier.value} oninput={(event) => { if (draft) draft.identifiers[index] = { ...identifier, value: event.currentTarget.value }; edited('identifiers'); }} />
										</div>
										<button type="button" class="secondary-button" aria-label={m['metadata.identifier.remove']({ number: index + 1 })} onclick={() => { if (draft) draft.identifiers = draft.identifiers.filter((_, position) => position !== index); edited('identifiers'); }}>{m['metadata.tags.remove']()}</button>
									</div>
								{/each}
								<button type="button" class="secondary-button" onclick={() => { if (draft) draft.identifiers = [...draft.identifiers, { scheme: '', value: '' }]; edited('identifiers'); }}>{m['metadata.identifier.add']()}</button>
							{:else if field === 'series'}
								<div>
									<label for="series-name">{m['metadata.series.name']()}</label>
									<input id="series-name" bind:value={draft.series.name} oninput={() => edited('series')} />
								</div>
								<div>
									<label for="series-index">{m['metadata.series.index']()}</label>
									<input id="series-index" inputmode="decimal" bind:value={draft.series.index} oninput={() => edited('series')} />
								</div>
							{:else if field === 'cover'}
								{#if selections.cover}
									<p class="text-sm">{m['metadata.cover.chosen']({ provider: selections.cover.provider })}</p>
									{#if chosenCoverPending}<p role="status">{m['metadata.cover.previewing']()}</p>
									{:else if chosenCoverUrl}<img class="cover-image" src={chosenCoverUrl} alt={m['metadata.cover.preview_alt']({ provider: selections.cover.provider })} />
									{:else if chosenCoverError}
										<p role="alert" class="text-red-800">{chosenCoverError}</p>
										<button type="button" class="secondary-button" disabled={busy || lookupPending} onclick={() => loadCover(selections.cover, lookup?.request_key, true)}>{m['catalog.retry']()}</button>
									{/if}
								{/if}
								{#if book.cover_url}<img class="cover-image" src={book.cover_url} alt={m['metadata.cover.current_alt']()} />
								{:else}<p class="text-slate-500">{m['metadata.cover.none']()}</p>{/if}
							{:else if field === 'description'}
								<label class="sr-only" for="metadata-description">{fieldLabels[field]()}</label>
								<textarea id="metadata-description" rows="6" bind:value={draft.description} oninput={() => edited(field)}></textarea>
							{:else}
								<label class="sr-only" for={`metadata-${field}`}>{fieldLabels[field]()}</label>
								<input id={`metadata-${field}`} inputmode={field === 'page_count' ? 'numeric' : 'text'} bind:value={draft[field]} oninput={() => edited(field)} />
							{/if}
						</div>
						<div class="copy-controls">
							{#if candidate}
								<button type="button" class="secondary-button" aria-label={m['metadata.field.use_found']({ field: fieldLabels[field]() })}
									title={m['metadata.field.use_found']({ field: fieldLabels[field]() })} disabled={lookupPending || !candidateOffers(candidate, field)}
									onclick={() => useFound(field)}>←</button>
							{/if}
							<button type="button" class="secondary-button" aria-label={m['metadata.field.restore']({ field: fieldLabels[field]() })}
								title={m['metadata.field.restore']({ field: fieldLabels[field]() })} onclick={() => restore(field)}>↶</button>
						</div>
						{#if candidate}
							<div class="found-value">
								{#if field === 'cover'}
									{#if !candidate.cover_url}<p class="text-slate-500">{m['metadata.cover.none']()}</p>
									{:else if previewPending}<p role="status">{m['metadata.cover.previewing']()}</p>
									{:else if previewUrl}<img class="cover-image" src={previewUrl} alt={m['metadata.cover.preview_alt']({ provider: candidate.provider })} />
									{:else if previewError}
										<p class="text-red-800" role="alert">{previewError}</p>
										<button type="button" class="secondary-button" disabled={busy || lookupPending} onclick={() => loadCover(candidate, lookup?.request_key, false)}>{m['catalog.retry']()}</button>
									{/if}
								{:else}
									{@render values(candidateValues(candidate, field, roleLabel), field)}
								{/if}
							</div>
						{/if}
					</div>
				</fieldset>
			{/each}
			{#if saveError}<p class="rounded-md bg-red-50 p-3 text-red-800" role="alert">{saveError}</p>{/if}
			{#if recoveryBlocked}
				<button type="button" class="secondary-button" disabled={saving || recovering} onclick={() => recoverFromConflict()}>{m['metadata.save.retry_recovery']()}</button>
			{/if}
			<div class="save-controls">
				<button type="submit" class="primary-button" disabled={busy || lookupPending || !dirty}>{saving ? m['metadata.save.saving']() : m['metadata.save.submit']()}</button>
				<button type="button" class="secondary-button" disabled={busy || !dirty} onclick={restoreAll}>{m['metadata.restore_all']()}</button>
			</div>
		</form>
	</article>
{/if}

<style>
	.metadata-form { min-width: 0; padding: 1rem; }
	.metadata-form label { display: block; margin-bottom: 0.25rem; font-size: 0.875rem; font-weight: 500; }
	input, textarea, select { width: 100%; min-width: 0; max-width: 100%; border: 1px solid #cbd5e1; border-radius: 0.375rem; padding: 0.5rem 0.75rem; }
	textarea { resize: vertical; }
	.primary-button, .secondary-button { border-radius: 0.375rem; padding: 0.5rem 0.75rem; font-size: 0.875rem; font-weight: 500; }
	.primary-button { background: #0f172a; color: white; }
	.secondary-button { border: 1px solid #cbd5e1; }
	button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid #334155; outline-offset: 2px; }
	button:disabled { opacity: 0.5; cursor: not-allowed; }
	fieldset:disabled .draft-value { opacity: 0.6; }
	.source-controls { display: grid; gap: 0.75rem; margin-bottom: 1.25rem; min-width: 0; }
	.source-controls > button { justify-self: start; }
	.source-tabs { display: flex; flex-wrap: wrap; gap: 0.5rem; }
	.source-tabs button { border: 1px solid #cbd5e1; border-radius: 0.375rem; padding: 0.5rem 0.75rem; overflow-wrap: anywhere; }
	.source-tabs button[aria-selected="true"] { border-color: #0f172a; background: #f1f5f9; font-weight: 600; }
	.metadata-row { min-width: 0; margin-top: 1rem; border-top: 1px solid #e2e8f0; padding-top: 0.75rem; }
	.metadata-row legend { padding-right: 0.5rem; font-weight: 600; }
	.comparison-grid, .comparison-heading { display: grid; grid-template-columns: minmax(0, 1fr) 3rem minmax(0, 1fr); gap: 0.75rem; }
	.metadata-form:not(.comparing) .comparison-grid { grid-template-columns: minmax(0, 1fr) 3rem; }
	.comparison-heading { font-size: 0.875rem; font-weight: 600; color: #475569; }
	.draft-value { display: grid; align-content: start; gap: 0.75rem; min-width: 0; }
	.draft-value > button { justify-self: start; }
	.found-value { min-width: 0; overflow-wrap: anywhere; font-size: 0.875rem; }
	.copy-controls { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
	.copy-controls button { width: 2.75rem; min-height: 2.75rem; padding: 0.25rem; font-size: 1.25rem; }
	.array-entry { display: grid; gap: 0.5rem; border: 1px solid #e2e8f0; border-radius: 0.375rem; padding: 0.5rem; min-width: 0; }
	.array-entry > button { justify-self: start; }
	.entry-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
	.tag-entry { display: flex; flex-wrap: wrap; gap: 0.5rem; min-width: 0; }
	.tag-entry input { flex: 1; min-width: 5rem; }
	.cover-image { max-width: 100%; max-height: 12rem; border-radius: 0.375rem; object-fit: contain; background: #f1f5f9; }
	.save-controls { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.5rem; border-top: 1px solid #e2e8f0; padding: 0.75rem 0; }
	@media (max-width: 639px) {
		.comparison-heading { display: none; }
		.comparison-grid { grid-template-columns: minmax(0, 1fr); }
		.copy-controls { flex-direction: row; }
		.found-value { border-left: 2px solid #e2e8f0; padding-left: 0.75rem; }
		.metadata-form { padding: 0.75rem; }
	}
</style>
