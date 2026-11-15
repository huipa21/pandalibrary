<script lang="ts">
	import type { WordbookEntry } from './api.js';
	import { lexicalEntry } from './management.js';
	import EntryDetail from './EntryDetail.svelte';

	let { entry, disabled = false, readonly = false, showSources = true, onsave, ondelete }: {
		entry: WordbookEntry;
		disabled?: boolean;
		readonly?: boolean;
		showSources?: boolean;
		onsave: (id: number, changes: { text: string; definition?: string; note?: string }) => Promise<boolean>;
		ondelete: (id: number) => Promise<void>;
	} = $props();
	let open = $state(false);
	const lexical = $derived(lexicalEntry(entry));
</script>

<article class="min-w-0">
	<button type="button" class="entry w-full space-y-2 rounded text-left" aria-label={entry.text} onclick={() => open = true}>
		<p class="whitespace-pre-wrap break-words text-lg font-medium" data-entry-text>{entry.text}</p>
		{#if lexical}
			{#if entry.definition}<p class="whitespace-pre-wrap break-words text-sm">{entry.definition}</p>{/if}
			{#each entry.dictionary_entries as snapshot}
				<div class="space-y-1 text-sm">
					<p class="text-slate-600">{snapshot.partOfSpeech ?? ''}{snapshot.partOfSpeech ? ' · ' : ''}{snapshot.sourceName}</p>
					<ul class="space-y-1">
						{#each snapshot.definitions as meaning}<li class="whitespace-pre-wrap break-words">{meaning}</li>{/each}
					</ul>
				</div>
			{/each}
		{:else if entry.note}
			<p class="whitespace-pre-wrap break-words text-sm">{entry.note}</p>
		{/if}
		{#if showSources}
			<p class="break-words text-sm text-slate-600">{entry.source.book_title}{entry.source.chapter ? ` · ${entry.source.chapter}` : ''}</p>
		{/if}
	</button>
	{#if open}
		<EntryDetail {entry} {disabled} {readonly} {onsave} {ondelete} onclose={() => open = false} />
	{/if}
</article>

<style>
	.entry:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
</style>
