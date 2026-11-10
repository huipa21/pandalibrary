<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { translate } from '#lib/paging/translate.js';
	import { AnnotationSearch } from '#lib/notes/AnnotationSearch.svelte.js';
	import PersonalActivityFeed from '#lib/notes/PersonalActivityFeed.svelte';
	import AnnotationEntry from '#lib/notes/AnnotationEntry.svelte';
	import Icon from '#lib/bookview/Icon.svelte';
	import {
		annotationErrorKey, annotationQueryIssue, isShortQuery,
		MAX_ANNOTATION_QUERY_CHARS, MAX_ANNOTATION_RESULTS, normalizeAnnotationQuery,
		NOTES_QUERY_PARAM, notesPageHref
	} from '#lib/notes/api.js';

	const search = new AnnotationSearch();
	const query = $derived(normalizeAnnotationQuery(page.url.searchParams.get(NOTES_QUERY_PARAM)));
	const queryIssue = $derived(annotationQueryIssue(query));
	let draft = $state('');
	let validation = $state('');
	let input = $state<HTMLInputElement | null>(null);
	const errorKind = $derived(requestErrorKind(search.error));

	$effect(() => {
		const current = query;
		const issue = queryIssue;
		untrack(() => {
			draft = current;
			validation = issue === 'too_long' ? m['notes.too_long']({ max: MAX_ANNOTATION_QUERY_CHARS }) : '';
			void search.search(issue ? '' : current);
		});
	});

	onDestroy(() => search.dispose());

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const next = normalizeAnnotationQuery(draft);
		if (annotationQueryIssue(next) === 'too_long') {
			validation = m['notes.too_long']({ max: MAX_ANNOTATION_QUERY_CHARS });
			return;
		}
		validation = '';
		if (next === query) {
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

	const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';
</script>

<svelte:head>
	<title>{query ? `${query} · ${m['notes.title']()}` : m['notes.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="notes-heading">
	<h1 id="notes-heading" class="text-2xl font-semibold">{m['notes.title']()}</h1>
	<form role="search" aria-label={m['notes.landmark']()} class="flex min-w-0 items-end gap-2" onsubmit={submit} novalidate>
		<label class="grid min-w-0 flex-1 gap-1 text-sm font-medium" for="notes-query">
			<span>{m['notes.label']()}</span>
			<input
				id="notes-query"
				type="search"
				name={NOTES_QUERY_PARAM}
				class="w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-normal {focusRing}"
				placeholder={m['notes.placeholder']()}
				autocomplete="off"
				aria-invalid={validation ? 'true' : undefined}
				aria-describedby="notes-query-hint{validation ? ' notes-validation' : ''}"
				bind:value={draft}
				bind:this={input}
			/>
		</label>
		<button type="submit" class="shell-search-submit inline-flex size-9 shrink-0 items-center justify-center rounded-md disabled:opacity-60 {focusRing}" aria-label={m['notes.submit']()} title={m['notes.submit']()} disabled={search.status === 'loading'}>
			<Icon name="search" class="size-4" />
		</button>
		<button type="button" class="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-600 disabled:opacity-60 {focusRing}" aria-label={m['notes.clear']()} title={m['notes.clear']()} disabled={!draft && !query} onclick={clear}>
			<Icon name="x" class="size-4" />
		</button>
	</form>
	<p id="notes-query-hint" class="-mt-5 text-sm text-slate-600">{m['notes.query_hint']({ max: MAX_ANNOTATION_QUERY_CHARS })}</p>
	{#if validation}
		<p id="notes-validation" class="text-sm text-red-700" role="alert">{validation}</p>
	{/if}

	{#if !query}
		<PersonalActivityFeed />
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
			{:else if search.status === 'loading'}
				<p role="status" class="text-sm text-slate-600">{m['notes.loading']()}</p>
			{:else if search.status === 'ready' && search.results.length === 0}
				<p role="status" class="text-sm text-slate-600">{m['notes.empty']({ query })}</p>
			{:else if search.status === 'ready'}
				<p role="status" class="text-sm text-slate-600">
					{m['notes.result_count']({ count: search.results.length })}
					{#if search.capped}{m['notes.capped']({ max: MAX_ANNOTATION_RESULTS })}{/if}
				</p>
				<ol class="divide-y divide-slate-200" aria-label={m['notes.results_label']()}>
					{#each search.results as item (`${item.kind}:${item.id}`)}
						<li><AnnotationEntry {item} /></li>
					{/each}
				</ol>
			{/if}
		</section>
	{/if}
</section>

<style>
	input::-webkit-search-cancel-button {
		-webkit-appearance: none;
		appearance: none;
		display: none;
	}
</style>
