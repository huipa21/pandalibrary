<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { ApiError } from '#lib/api/client.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getBook } from '#lib/catalog/api.js';
	import { catalogErrorMessage } from '#lib/catalog/errors.js';
	import type { Book } from '#lib/catalog/types.js';
	import { getSessionViewer } from '#lib/shelves/api.js';
	import { isAdministrator } from '#lib/shelves/form.js';
	import { applyMetadata, fetchCoverPreview, lookupCandidates } from '#lib/metadata/api.js';
	import {
		allCandidates,
		candidateClears,
		candidateCount,
		candidateKey,
		candidateOffers,
		candidateValues,
		currentValues,
		matchesCurrent,
		pruneSelections,
		sameCandidate,
		selectCandidateValues,
		selectField,
		selectionCount
	} from '#lib/metadata/merge.js';
	import { ObjectUrlSlot } from '#lib/metadata/object-url.js';
	import { MERGE_FIELDS, type Candidate, type LookupResponse, type MergeField, type Selections } from '#lib/metadata/types.js';

	let book = $state<Book | null>(null);
	let loading = $state(true);
	let error = $state('');
	let forbidden = $state(false);
	let lookup = $state<LookupResponse | null>(null);
	let lookupPending = $state(false);
	let lookupError = $state('');
	let selections = $state<Selections>({});
	let applying = $state(false);
	let notice = $state('');
	let applyError = $state('');
	let previewKey = $state<string | null>(null);
	let previewUrl = $state<string | null>(null);
	let previewPending = $state<string | null>(null);
	let previewError = $state('');
	let version = 0;
	let lookupController: AbortController | null = null;
	let previewController: AbortController | null = null;
	const preview = new ObjectUrlSlot();

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

	const candidates = $derived(lookup ? allCandidates(lookup.providers) : []);
	const selected = $derived(selectionCount(selections));
	const partialFailure = $derived(!!lookup && lookup.providers.some((provider) => provider.error !== null));

	$effect(() => {
		const id = page.params.id ?? '';
		void load(id);
	});

	onDestroy(() => {
		version += 1;
		lookupController?.abort();
		previewController?.abort();
		preview.clear();
	});

	function clearPreview() {
		previewController?.abort();
		previewController = null;
		preview.clear();
		previewKey = null;
		previewUrl = null;
		previewPending = null;
		previewError = '';
	}

	function resetMerge() {
		lookupController?.abort();
		lookupController = null;
		clearPreview();
		lookup = null;
		lookupPending = false;
		lookupError = '';
		selections = {};
		applying = false;
		notice = '';
		applyError = '';
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

	/** Maps authoritative server statuses; returns true when the page-level state changed. */
	function handleAccessError(cause: unknown): boolean {
		if (!(cause instanceof ApiError)) return false;
		if (cause.status === 401) {
			error = m['metadata.edit.session_expired']();
		} else if (cause.status === 403) {
			forbidden = true;
		} else if (cause.status === 404) {
			error = m['catalog.error.not_found']();
		} else {
			return false;
		}
		book = null;
		resetMerge();
		return true;
	}

	async function load(id: string) {
		const request = ++version;
		resetMerge();
		book = null;
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

	async function runLookup(options: { keepSelections: boolean }) {
		if (!book || lookupPending) return;
		const request = version;
		const bookId = book.id;
		const controller = new AbortController();
		lookupController = controller;
		lookupPending = true;
		lookupError = '';
		clearPreview();
		try {
			const result = await lookupCandidates(bookId, controller.signal);
			if (request !== version || controller.signal.aborted) return;
			lookup = result;
			selections = options.keepSelections ? pruneSelections(selections, result.providers) : {};
		} catch (cause) {
			if (request !== version || controller.signal.aborted) return;
			if (!handleAccessError(cause)) {
				console.error('Metadata lookup failed', cause);
				lookupError = m['metadata.lookup.failure']();
			}
		} finally {
			if (lookupController === controller) {
				lookupController = null;
				lookupPending = false;
			}
		}
	}

	async function recoverFromConflict() {
		applyError = m['metadata.apply.conflict']();
		selections = {};
		lookup = null;
		await runLookup({ keepSelections: false });
	}

	async function apply() {
		if (!book || !lookup || applying || lookupPending) return;
		notice = '';
		applyError = '';
		if (selected === 0) {
			applyError = m['metadata.apply.none']();
			return;
		}
		const request = version;
		applying = true;
		try {
			const updated = await applyMetadata(book.id, lookup.request_key, $state.snapshot(selections));
			if (request !== version) return;
			book = updated;
			selections = {};
			clearPreview();
			notice = m['metadata.apply.success']();
		} catch (cause) {
			if (request !== version) return;
			if (cause instanceof ApiError && cause.status === 409) {
				applying = false;
				await recoverFromConflict();
				return;
			}
			if (handleAccessError(cause)) return;
			console.error('Metadata apply failed', cause);
			applyError = cause instanceof ApiError && cause.status === 400
				? m['metadata.apply.invalid']()
				: m['metadata.apply.failure']();
		} finally {
			if (request === version) applying = false;
		}
	}

	async function showPreview(candidate: Candidate) {
		if (!book || !lookup || previewPending !== null) return;
		const key = candidateKey(candidate);
		const request = version;
		const requestKey = lookup.request_key;
		clearPreview();
		const controller = new AbortController();
		previewController = controller;
		previewPending = key;
		try {
			const blob = await fetchCoverPreview(book.id, requestKey, candidate, controller.signal);
			if (request !== version || controller.signal.aborted || lookup?.request_key !== requestKey) return;
			previewUrl = preview.set(blob);
			previewKey = key;
		} catch (cause) {
			if (request !== version || controller.signal.aborted) return;
			if (cause instanceof ApiError && cause.status === 409) {
				previewPending = null;
				await recoverFromConflict();
				return;
			}
			if (handleAccessError(cause)) return;
			console.error('Cover preview failed', cause);
			previewError = m['metadata.cover.preview_failure']();
			previewKey = key;
		} finally {
			if (previewController === controller) {
				previewController = null;
				previewPending = null;
			}
		}
	}

	function choose(field: MergeField, candidate: Candidate | null) {
		selections = selectField(selections, field, candidate);
		notice = '';
		applyError = '';
	}

	function chooseAll(candidate: Candidate) {
		selections = selectCandidateValues(selections, candidate);
		notice = '';
		applyError = '';
	}

	function radioId(field: MergeField, index: number | 'keep'): string {
		return `merge-${field}-${index}`;
	}
</script>

{#snippet values(items: string[], field: MergeField)}
	{#if items.length === 0}
		<span class="text-slate-500">{m['metadata.field.empty']()}</span>
	{:else if field === 'description'}
		<span class="block max-h-40 overflow-y-auto whitespace-pre-wrap">{items[0]}</span>
	{:else if items.length === 1}
		<span class="break-words">{items[0]}</span>
	{:else}
		<ol class="list-inside list-decimal space-y-0.5 break-words">
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
{:else if book}
	<article class="space-y-8">
		<header class="space-y-3">
			<a class="text-sm text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2" href={`/books/${book.id}`}>
				{m['metadata.edit.back']()}
			</a>
			<h1 class="text-3xl font-semibold tracking-tight">{m['metadata.edit.title']({ title: book.title })}</h1>
			<p class="text-slate-600">{m['metadata.edit.description']()}</p>
		</header>

		<section aria-labelledby="lookup-heading" class="space-y-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h2 id="lookup-heading" class="text-xl font-semibold">{m['metadata.lookup.heading']()}</h2>
				<button
					class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
					disabled={lookupPending || applying}
					onclick={() => runLookup({ keepSelections: true })}
				>
					{lookup ? m['metadata.lookup.again']() : m['metadata.lookup.start']()}
				</button>
			</div>
			<div aria-live="polite" role="status" class="space-y-2 text-sm">
				{#if lookupPending}
					<p class="text-slate-600">{m['metadata.lookup.loading']()}</p>
				{:else if lookup && candidates.length === 0}
					<p class="text-slate-600">{m['metadata.lookup.empty']()}</p>
				{:else if lookup}
					<p class="text-slate-600">{m['metadata.lookup.ready']({ count: candidateCount(lookup.providers) })}</p>
				{/if}
				{#if notice}<p class="rounded-md bg-green-50 p-3 text-green-800">{notice}</p>{/if}
			</div>
			{#if lookupError}
				<div class="space-y-2" role="alert">
					<p class="rounded-md bg-red-50 p-3 text-sm text-red-800">{lookupError}</p>
				</div>
			{/if}
			{#if applyError}
				<p class="rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">{applyError}</p>
			{/if}

			{#if lookup}
				{#if partialFailure}
					<p class="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{m['metadata.lookup.partial']()}</p>
				{/if}
				{#if Object.keys(lookup.query).length}
					<p class="text-sm text-slate-600">
						{m['metadata.lookup.query']()}:
						{Object.entries(lookup.query).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(' · ')}
					</p>
				{/if}
				<ul class="space-y-3">
					{#each lookup.providers as provider (provider.provider)}
						<li class="card p-3" data-provider={provider.provider}>
							{#if provider.error}
								<p class="text-sm text-amber-900">{m['metadata.provider.failed']({ provider: provider.provider, code: provider.error.code || '—' })}</p>
							{/if}
							{#if provider.candidates.length || !provider.error}
								<p class="text-sm font-medium">{m['metadata.provider.count']({ provider: provider.provider, count: provider.candidates.length })}</p>
							{/if}
							{#if provider.candidates.length}
								<ul class="mt-2 flex flex-wrap gap-2">
									{#each provider.candidates as candidate (candidateKey(candidate))}
										<li>
											<button
												class="rounded-md border border-slate-300 px-2 py-1 text-left text-sm focus-visible:outline-2 disabled:opacity-60"
												disabled={applying || lookupPending}
												aria-label={m['metadata.candidate.use_all']({ provider: candidate.provider, title: candidate.title })}
												onclick={() => chooseAll(candidate)}
											>
												{candidate.title}
											</button>
										</li>
									{/each}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if lookup && candidates.length}
			<form class="space-y-6" onsubmit={(event) => { event.preventDefault(); void apply(); }}>
				{#each MERGE_FIELDS as field (field)}
					{@const options = candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => candidateOffers(candidate, field))}
					<fieldset class="space-y-2 card p-4" data-field={field}>
						<legend class="px-1 font-semibold">{fieldLabels[field]()}</legend>
						<div class="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
							<label class="flex cursor-pointer gap-2 rounded-md border border-slate-200 p-3 has-[:checked]:border-slate-900 has-[:checked]:bg-slate-50" for={radioId(field, 'keep')}>
								<input
									id={radioId(field, 'keep')}
									type="radio"
									name={`merge-${field}`}
									checked={selections[field] === undefined}
									disabled={applying}
									onchange={() => choose(field, null)}
								/>
								<span class="min-w-0 flex-1 space-y-1 text-sm">
									<span class="block font-medium">{m['metadata.field.keep']()}</span>
									{#if field === 'cover'}
										{#if book.cover_url}
											<img class="max-h-48 rounded bg-slate-100 object-contain" src={book.cover_url} alt={m['metadata.cover.current_alt']()} />
										{:else}
											<span class="text-slate-500">{m['metadata.cover.none']()}</span>
										{/if}
									{:else}
										{@render values(currentValues(book, field, roleLabel), field)}
									{/if}
								</span>
							</label>
							{#each options as { candidate, index } (candidateKey(candidate))}
								{@const key = candidateKey(candidate)}
								<div class="flex gap-2 rounded-md border border-slate-200 p-3 has-[:checked]:border-slate-900 has-[:checked]:bg-slate-50">
									<input
										id={radioId(field, index)}
										type="radio"
										name={`merge-${field}`}
										checked={sameCandidate(selections[field], candidate)}
										disabled={applying}
										onchange={() => choose(field, candidate)}
									/>
									<div class="min-w-0 flex-1 space-y-1 text-sm">
										<label class="block cursor-pointer font-medium" for={radioId(field, index)}>
											{m['metadata.candidate.label']({ provider: candidate.provider, title: candidate.title })}
										</label>
										{#if field === 'cover'}
											<button
												type="button"
												class="text-sm underline underline-offset-4 focus-visible:outline-2 disabled:opacity-60"
												disabled={previewPending !== null || lookupPending}
												onclick={() => showPreview(candidate)}
											>
												{previewPending === key ? m['metadata.cover.previewing']() : m['metadata.cover.preview']()}
											</button>
											{#if previewKey === key && previewUrl}
												<img class="max-h-48 rounded bg-slate-100 object-contain" src={previewUrl} alt={m['metadata.cover.preview_alt']({ provider: candidate.provider })} />
											{:else if previewKey === key && previewError}
												<p class="text-red-700" role="alert">{previewError}</p>
											{/if}
										{:else}
											{@render values(candidateValues(candidate, field, roleLabel), field)}
											{#if candidateClears(candidate, field) && currentValues(book, field).length}
												<span class="block text-amber-800">{m['metadata.field.clears']()}</span>
											{:else if matchesCurrent(book, candidate, field)}
												<span class="block text-slate-500">{m['metadata.field.matches']()}</span>
											{/if}
										{/if}
									</div>
								</div>
							{/each}
						</div>
					</fieldset>
				{/each}

				<div class="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-[var(--shell-bg)] py-3">
					<button
						type="submit"
						class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
						disabled={applying || lookupPending || selected === 0}
					>
						{applying ? m['metadata.apply.applying']() : m['metadata.apply.submit']({ count: selected })}
					</button>
					<button
						type="button"
						class="rounded-md border border-slate-300 px-4 py-2 font-medium focus-visible:outline-2 disabled:opacity-60"
						disabled={applying || selected === 0}
						onclick={() => { selections = {}; }}
					>
						{m['metadata.reset']()}
					</button>
				</div>
			</form>
		{/if}
	</article>
{/if}
