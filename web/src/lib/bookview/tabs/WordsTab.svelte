<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { wordbooks, type WordbookEntry } from '#lib/wordbooks/api.js';
	import { lexicalEntry, sortEntries, sourceHref } from '#lib/wordbooks/management.js';
	import { getBookContext } from '../book-context.svelte.js';

	const context = getBookContext();
	const bookId = $derived(context.bookId);
	let entries = $state<WordbookEntry[]>([]);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let requestVersion = 0;
	const kindLabels = {
		word: m['wordbooks.word'], phrase: m['wordbooks.phrase'],
		sentence: m['wordbooks.sentence'], passage: m['wordbooks.passage']
	};

	async function load(id: number) {
		const version = ++requestVersion;
		status = 'loading';
		entries = [];
		try {
			const result = await wordbooks.bookEntries(id);
			if (version !== requestVersion) return;
			entries = sortEntries(result, 'chronological');
			status = 'ready';
		} catch {
			if (version === requestVersion) status = 'error';
		}
	}

	$effect(() => {
		const id = bookId;
		if (id !== null) untrack(() => void load(id));
		return () => { requestVersion += 1; };
	});
</script>

<section class="card min-w-0 p-4 sm:p-6" aria-labelledby="book-words-title">
	<h1 id="book-words-title" class="mb-4 text-xl font-semibold">{m['bv4.words.title']()}</h1>
	{#if status === 'loading'}
		<p use:showLoadingAfterDelay role="status" class="text-sm text-slate-600">{m['catalog.loading']()}</p>
	{:else if status === 'error'}
		<div role="alert" class="space-y-2 text-sm">
			<p class="text-red-800">{m['bv4.words.error']()}</p>
			<button type="button" class="underline underline-offset-4 focus-visible:outline-2" onclick={() => {
				if (bookId !== null) void load(bookId);
			}}>{m['catalog.retry']()}</button>
		</div>
	{:else if entries.length === 0}
		<p class="text-sm text-slate-600">{m['bv4.words.empty']()}</p>
	{:else}
		<ol class="divide-y divide-slate-200" data-book-words>
			{#each entries as entry (entry.id)}
				{@const href = sourceHref(entry.source)}
				{@const annotation = lexicalEntry(entry) ? entry.definition : entry.note}
				<li class="space-y-1 py-3 first:pt-0 last:pb-0" data-entry-id={entry.id}>
					<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<span class="text-xs font-medium text-slate-500">{kindLabels[entry.kind]()}</span>
						<p class="min-w-0 whitespace-pre-wrap break-words text-sm font-medium" data-entry-text>{entry.text}</p>
					</div>
					{#if annotation}
						<p class="whitespace-pre-wrap break-words text-sm text-slate-700">{annotation}</p>
					{/if}
					<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-slate-600">
						{#if entry.source.chapter}<span class="break-words">{entry.source.chapter}</span>{/if}
						{#if href}
							<a class="underline underline-offset-2 focus-visible:outline-2" {href}>{m['wordbooks.context']()}</a>
						{:else}
							<span>{m['wordbooks.source_unavailable']()}</span>
						{/if}
						<a class="underline underline-offset-2 focus-visible:outline-2" href={`/wordbooks?id=${entry.wordbook_id}`}>{m['bv4.words.wordbook']()}</a>
					</div>
				</li>
			{/each}
		</ol>
	{/if}
</section>
