<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { WordbookEntry } from './api.js';
	import { lexicalEntry, sourceHref } from './management.js';

	let { entry, disabled = false, onsave, ondelete }: {
		entry: WordbookEntry;
		disabled?: boolean;
		onsave: (id: number, changes: { text: string; definition?: string; note?: string }) => Promise<boolean>;
		ondelete: (id: number) => Promise<void>;
	} = $props();
	let editing = $state(false);
	let text = $state('');
	let definition = $state('');
	let note = $state('');
	const lexical = $derived(lexicalEntry(entry));
	const href = $derived(sourceHref(entry.source));
	const kindLabels = {
		word: m['wordbooks.word'], phrase: m['wordbooks.phrase'],
		sentence: m['wordbooks.sentence'], passage: m['wordbooks.passage']
	};

	function edit() {
		text = entry.text;
		definition = entry.definition;
		note = entry.note;
		editing = true;
	}
	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!text.trim()) return;
		if (await onsave(entry.id, { text: text.trim(), ...(lexical ? { definition } : { note }) })) editing = false;
	}
</script>

<article class="space-y-4" aria-label={entry.text}>
	<div class="flex flex-wrap items-start justify-between gap-2">
		<p class="text-xs font-medium text-slate-600">{kindLabels[entry.kind]()}</p>
		{#if !editing}
			<div class="flex gap-3">
				<button class="action" {disabled} onclick={edit}>{m['wordbooks.edit']()}</button>
				<button class="action text-red-700" {disabled} onclick={() => {
					if (confirm(m['wordbooks.delete_confirm']())) void ondelete(entry.id);
				}}>{m['wordbooks.delete']()}</button>
			</div>
		{/if}
	</div>
	{#if editing}
		<form onsubmit={save} class="space-y-3">
			<label class="block space-y-1">
				<span class="text-sm font-medium">{m['wordbooks.text']()}</span>
				<textarea class="field" rows="3" required bind:value={text} {disabled}></textarea>
			</label>
			{#if lexical}
				<label class="block space-y-1">
					<span class="text-sm font-medium">{m['wordbooks.definition']()}</span>
					<textarea class="field" rows="4" bind:value={definition} {disabled}></textarea>
				</label>
			{:else}
				<label class="block space-y-1">
					<span class="text-sm font-medium">{m['wordbooks.note']()}</span>
					<textarea class="field" rows="4" bind:value={note} {disabled}></textarea>
				</label>
			{/if}
			<div class="flex gap-3">
				<button class="action" type="submit" disabled={disabled || !text.trim()}>{m['wordbooks.save']()}</button>
				<button class="action" type="button" {disabled} onclick={() => editing = false}>{m['wordbooks.cancel']()}</button>
			</div>
		</form>
	{:else}
		<p class="whitespace-pre-wrap break-words text-lg font-medium" data-entry-text>{entry.text}</p>
		{#if lexical && entry.definition}
			<div><h3 class="text-sm font-medium text-slate-600">{m['wordbooks.definition']()}</h3><p class="whitespace-pre-wrap break-words">{entry.definition}</p></div>
		{:else if !lexical}
			<div><h3 class="text-sm font-medium text-slate-600">{m['wordbooks.note']()}</h3><p class="whitespace-pre-wrap break-words">{entry.note}</p></div>
		{/if}
	{/if}
	{#if lexical && entry.dictionary_entries.length}
		<section aria-label={m['wordbooks.dictionary']()} class="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
			<h3 class="font-medium">{m['wordbooks.dictionary']()}</h3>
			{#each entry.dictionary_entries as snapshot}
				<div class="space-y-1">
					<p><strong>{snapshot.headword}</strong> {snapshot.reading ?? ''} <span class="text-slate-600">{snapshot.partOfSpeech ?? ''} · {snapshot.sourceName}</span></p>
					<ul class="list-disc space-y-1 pl-5">
						{#each snapshot.definitions as meaning}<li class="whitespace-pre-wrap break-words">{meaning}</li>{/each}
					</ul>
				</div>
			{/each}
		</section>
	{/if}
	{#if entry.dictionary_warning}
		<p class="text-sm text-amber-800" role="status">{m['wordbooks.dictionary_warning']()}</p>
	{/if}
	<div class="space-y-1 text-sm text-slate-600">
		<p class="break-words"><span class="font-medium">{m['wordbooks.source']()}:</span> {entry.source.book_title}{entry.source.chapter ? ` · ${entry.source.chapter}` : ''}</p>
		{#if href}<a class="action inline-block" {href}>{m['wordbooks.context']()}</a>
		{:else}<p>{m['wordbooks.source_unavailable']()}</p>{/if}
	</div>
</article>

<style>
	.action { border-radius: .25rem; text-decoration: underline; text-underline-offset: .2em; padding: .25rem; }
	.action:focus-visible, .field:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
	.action:disabled { opacity: .5; }
	.field { display: block; width: 100%; min-width: 0; border: 1px solid #94a3b8; border-radius: .375rem; padding: .5rem; background: white; }
</style>
