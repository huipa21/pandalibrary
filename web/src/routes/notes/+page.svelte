<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { translate } from '#lib/paging/translate.js';
	import { AnnotationSearch } from '#lib/notes/AnnotationSearch.svelte.js';
	import {
		annotationErrorKey,
		annotationQueryIssue,
		excerpt,
		isShortQuery,
		MAX_ANNOTATION_QUERY_CHARS,
		MAX_ANNOTATION_RESULTS,
		normalizeAnnotationQuery,
		NOTES_QUERY_PARAM,
		notesPageHref,
		positionPercent
	} from '#lib/notes/api.js';
	import {
		ExportError,
		exportFormat,
		MAX_EXPORT_BOOKS,
		requestNotesExport,
		saveBlob,
		selectBooks,
		toggleBook,
		type ExportErrorKind
	} from '#lib/notes/export.js';
	import type { AnnotationResult } from '#lib/notes/types.js';

	const search = new AnnotationSearch();
	const query = $derived(normalizeAnnotationQuery(page.url.searchParams.get(NOTES_QUERY_PARAM)));
	const queryIssue = $derived(annotationQueryIssue(query));
	let draft = $state('');
	let validation = $state('');
	let input = $state<HTMLInputElement | null>(null);

	let selected = $state<number[]>([]);
	let limitReached = $state(false);
	let exporting = $state(false);
	let exportDone = $state('');
	let exportFailure = $state<ExportErrorKind | null>(null);

	const books = $derived(search.status === 'ready' ? search.books : []);
	const visibleIds = $derived(new Set(books.map((book) => book.book_id)));
	// Only books represented by the visible results can be exported.
	const selection = $derived(selected.filter((id) => visibleIds.has(id)));
	const selectionSet = $derived(new Set(selection));
	const format = $derived(exportFormat(selection.length));
	const errorKind = $derived(requestErrorKind(search.error));
	const locale = $derived(getLocale());
	const dateFormat = $derived(new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }));

	$effect(() => {
		const current = query;
		const issue = queryIssue;
		untrack(() => {
			draft = current;
			validation = issue === 'too_long' ? m['notes.too_long']({ max: MAX_ANNOTATION_QUERY_CHARS }) : '';
			resetExport();
			void search.search(issue ? '' : current);
		});
	});

	onDestroy(() => search.dispose());

	function resetExport() {
		selected = [];
		limitReached = false;
		exportDone = '';
		exportFailure = null;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const next = normalizeAnnotationQuery(draft);
		if (annotationQueryIssue(next) === 'too_long') {
			validation = m['notes.too_long']({ max: MAX_ANNOTATION_QUERY_CHARS });
			return;
		}
		validation = '';
		if (next === query) {
			// The same query is only requested again after a failure, never while pending.
			if (search.status === 'error') await search.retry();
			return;
		}
		await goto(notesPageHref(next), { reset: false });
	}

	async function clear() {
		draft = '';
		validation = '';
		if (query) await goto('/notes', { reset: false });
		await tick();
		input?.focus();
	}

	function toggle(event: Event, bookId: number) {
		const change = toggleBook(selection, bookId, MAX_EXPORT_BOOKS);
		selected = change.selection;
		limitReached = change.limited;
		exportDone = '';
		(event.currentTarget as HTMLInputElement).checked = change.selection.includes(bookId);
	}

	function selectAll() {
		const change = selectBooks(books.map((book) => book.book_id), MAX_EXPORT_BOOKS);
		selected = change.selection;
		limitReached = change.limited;
		exportDone = '';
	}

	function clearSelection() {
		selected = [];
		limitReached = false;
		exportDone = '';
	}

	async function download() {
		if (exporting || selection.length === 0) return;
		exporting = true;
		exportDone = '';
		exportFailure = null;
		try {
			const result = await requestNotesExport(selection);
			saveBlob(result.blob, result.filename);
			exportDone = m['notes.export.done']({ filename: result.filename });
		} catch (cause) {
			console.error('Could not export notes', cause);
			exportFailure = cause instanceof ExportError ? cause.kind : cause instanceof RangeError ? 'invalid' : 'unexpected';
		} finally {
			exporting = false;
		}
	}

	function exportErrorMessage(kind: ExportErrorKind): string {
		return translate(`notes.export.error.${kind === 'unauthorized' ? 'session' : kind}`);
	}

	function kindLabel(result: AnnotationResult): string {
		if (result.kind === 'highlight') return m['notes.kind.highlight']();
		if (result.kind === 'note') return m['notes.kind.note']();
		return result.kind;
	}

	function createdLabel(value: string): string {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
	}

	const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';
</script>

<svelte:head>
	<title>{query ? `${query} · ${m['notes.title']()}` : m['notes.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="notes-heading">
	<header class="space-y-2">
		<h1 id="notes-heading" class="text-3xl font-semibold tracking-tight">{m['notes.title']()}</h1>
		<p class="text-slate-600">{m['notes.description']()}</p>
	</header>

	<form role="search" aria-label={m['notes.landmark']()} class="flex flex-wrap items-end gap-3" onsubmit={submit} novalidate>
		<label class="grid min-w-0 flex-1 gap-1 text-sm font-medium" for="notes-query">
			<span>{m['notes.label']()}</span>
			<input
				id="notes-query"
				type="search"
				name={NOTES_QUERY_PARAM}
				class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base font-normal {focusRing}"
				placeholder={m['notes.placeholder']()}
				autocomplete="off"
				aria-invalid={validation ? 'true' : undefined}
				aria-describedby="notes-query-hint{validation ? ' notes-validation' : ''}"
				bind:value={draft}
				bind:this={input}
			/>
		</label>
		<button type="submit" class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60 {focusRing}" disabled={search.status === 'loading'}>
			{m['notes.submit']()}
		</button>
		<button type="button" class="rounded-md border border-slate-300 px-4 py-2 disabled:opacity-60 {focusRing}" disabled={!draft && !query} onclick={clear}>
			{m['notes.clear']()}
		</button>
	</form>
	<p id="notes-query-hint" class="-mt-5 text-sm text-slate-600">{m['notes.query_hint']({ max: MAX_ANNOTATION_QUERY_CHARS })}</p>
	{#if validation}
		<p id="notes-validation" class="text-sm text-red-700" role="alert">{validation}</p>
	{/if}

	{#if !query}
		<p class="rounded-md border border-slate-200 bg-white p-6 text-slate-600">{m['notes.prompt']()}</p>
	{:else if !queryIssue}
		<section class="space-y-4" aria-labelledby="notes-results-heading" aria-busy={search.status === 'loading'}>
			<h2 id="notes-results-heading" class="text-xl font-semibold break-words">{m['notes.results_heading']({ query })}</h2>
			{#if isShortQuery(query)}
				<p class="text-sm text-slate-600">{m['notes.short_hint']()}</p>
			{/if}

			{#if search.status === 'error'}
				<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
					<p>{translate(annotationErrorKey(search.error))}</p>
					{#if errorKind === 'unauthorized'}
						<a class="underline underline-offset-4 {focusRing}" href="/login">{m['notes.sign_in']()}</a>
					{:else if errorKind === 'invalid'}
						<button class="underline underline-offset-4 {focusRing}" onclick={clear}>{m['notes.restart']()}</button>
					{:else}
						<button class="underline underline-offset-4 {focusRing}" onclick={() => search.retry()}>{m['notes.retry']()}</button>
					{/if}
				</div>
			{:else if search.status === 'loading' || search.status === 'idle'}
				<p class="text-slate-600" role="status">{m['notes.loading']()}</p>
			{:else if search.empty}
				<p class="rounded-md border border-slate-200 bg-white p-6 text-slate-600" role="status">{m['notes.empty']({ query })}</p>
			{:else}
				<p class="text-sm text-slate-600" role="status">
					{m['notes.result_count']({ count: search.results.length })}
					{#if search.capped}{m['notes.capped']({ max: MAX_ANNOTATION_RESULTS })}{/if}
				</p>

				<section class="space-y-3 rounded-md border border-slate-200 bg-white p-4" aria-labelledby="notes-export-heading">
					<h3 id="notes-export-heading" class="text-lg font-semibold">{m['notes.export.heading']()}</h3>
					<p class="text-sm text-slate-600">{m['notes.export.description']({ max: MAX_EXPORT_BOOKS })}</p>
					<fieldset class="space-y-2">
						<legend class="text-sm font-medium">{m['notes.export.legend']()}</legend>
						<ul class="grid max-h-60 gap-2 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
							{#each books as book (book.book_id)}
								<li>
									<label class="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-50">
										<input
											type="checkbox"
											class="size-4 {focusRing}"
											checked={selectionSet.has(book.book_id)}
											onchange={(event) => toggle(event, book.book_id)}
										/>
										<span>{m['notes.export.book_option']({ id: book.book_id, count: book.matches })}</span>
									</label>
								</li>
							{/each}
						</ul>
					</fieldset>
					<div class="flex flex-wrap items-center gap-2">
						<button type="button" class="rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60 {focusRing}" disabled={selection.length === Math.min(books.length, MAX_EXPORT_BOOKS)} onclick={selectAll}>
							{m['notes.export.select_all']()}
						</button>
						<button type="button" class="rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60 {focusRing}" disabled={selection.length === 0} onclick={clearSelection}>
							{m['notes.export.clear']()}
						</button>
						<button
							type="button"
							class="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60 {focusRing}"
							disabled={selection.length === 0 || exporting}
							aria-describedby="notes-export-selected"
							onclick={download}
						>
							{#if exporting}
								{m['notes.export.downloading']()}
							{:else if format === 'zip'}
								{m['notes.export.download_zip']({ count: selection.length })}
							{:else}
								{m['notes.export.download_markdown']()}
							{/if}
						</button>
					</div>
					<p id="notes-export-selected" class="text-sm text-slate-600" role="status">
						{selection.length === 0
							? m['notes.export.none']()
							: m['notes.export.selected']({ count: selection.length, max: MAX_EXPORT_BOOKS })}
					</p>
					{#if limitReached}
						<p class="text-sm text-amber-800" role="alert">{m['notes.export.limit']({ max: MAX_EXPORT_BOOKS })}</p>
					{/if}
					{#if exportDone}
						<p class="text-sm text-green-700" role="status">{exportDone}</p>
					{/if}
					{#if exportFailure}
						<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
							<p>{exportErrorMessage(exportFailure)}</p>
							{#if exportFailure === 'unauthorized'}
								<a class="underline underline-offset-4 {focusRing}" href="/login">{m['notes.sign_in']()}</a>
							{/if}
						</div>
					{/if}
				</section>

				<ol class="space-y-3" aria-label={m['notes.results_label']()}>
					{#each search.results as result (`${result.kind}:${result.id}`)}
						{@const percent = positionPercent(result)}
						<li class="space-y-2 rounded-md border border-slate-200 bg-white p-4">
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
								<span class="rounded-full px-2 py-0.5 font-medium {result.kind === 'highlight' ? 'bg-amber-100 text-amber-900' : 'bg-sky-100 text-sky-900'}">{kindLabel(result)}</span>
								{#if percent !== null}<span>{m['notes.position']({ percent })}</span>{/if}
								<time datetime={result.created_at}>{m['notes.created']({ date: createdLabel(result.created_at) })}</time>
							</div>
							<p class="break-words whitespace-pre-line text-slate-900">{excerpt(result.content)}</p>
							<a class="inline-block text-sm font-medium underline-offset-4 hover:underline {focusRing}" href={`/books/${result.book_id}`}>
								{m['notes.open_book']({ id: result.book_id })}
							</a>
						</li>
					{/each}
				</ol>
			{/if}
		</section>
	{/if}
</section>
