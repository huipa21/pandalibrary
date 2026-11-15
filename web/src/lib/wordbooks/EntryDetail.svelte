<script lang="ts">
	import { confirmAction } from '#lib/shell/confirmation.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { WordbookEntry } from './api.js';
	import { lexicalEntry, sourceHref } from './management.js';

	let { entry, disabled = false, readonly = false, onsave, ondelete, onclose }: {
		entry: WordbookEntry;
		disabled?: boolean;
		readonly?: boolean;
		onsave: (id: number, changes: { text: string; definition?: string; note?: string }) => Promise<boolean>;
		ondelete: (id: number) => Promise<void>;
		onclose: () => void;
	} = $props();
	let dialog = $state<HTMLDialogElement | null>(null);
	let editing = $state(false);
	let text = $state('');
	let definition = $state('');
	let note = $state('');
	const lexical = $derived(lexicalEntry(entry));
	const href = $derived(sourceHref(entry.source));
	const page = $derived(
		entry.source.locator && typeof entry.source.locator === 'object' && !Array.isArray(entry.source.locator)
			&& typeof entry.source.locator.page === 'number' && entry.source.locator.page > 0
			? entry.source.locator.page : null
	);
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
	$effect(() => {
		if (!dialog) return;
		const element = dialog;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		element.showModal();
		return () => {
			if (element.open) element.close();
			if (previous?.isConnected) previous.focus();
		};
	});

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const target = nextTrappedFocus(focusableWithin(dialog), document.activeElement, event.shiftKey);
		if (target) { event.preventDefault(); target.focus(); }
	}
</script>

<dialog bind:this={dialog} class="fixed inset-0 m-auto max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-6 text-slate-950 shadow-lg" aria-label={m['wordbooks.entry_details']()} oncancel={(event) => { event.preventDefault(); onclose(); }} {onkeydown}>
<article class="space-y-4" aria-label={entry.text}>
	<div class="flex flex-wrap items-start justify-between gap-2">
		<p class="text-xs font-medium text-slate-600">{kindLabels[entry.kind]()}</p>
		{#if !editing && !readonly}
			<div class="flex gap-3">
				<button class="action" {disabled} onclick={edit}>{m['wordbooks.edit']()}</button>
				<button class="action text-red-700" {disabled} onclick={async () => {
					if (await confirmAction(m['wordbooks.delete_confirm']())) await ondelete(entry.id);
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
		<p class="break-words"><span class="font-medium">{m['wordbooks.source']()}:</span> {entry.source.book_title}{entry.source.chapter ? ` · ${entry.source.chapter}` : ''}{page ? ` · ${m['reader.search.page']({ page })}` : ''}</p>
		{#if href}<a class="action inline-block" {href}>{m['wordbooks.context']()}</a>
		{:else}<p>{m['wordbooks.source_unavailable']()}</p>{/if}
	</div>
	<button class="action" type="button" onclick={onclose}>{m['wordbooks.cancel']()}</button>
</article>
</dialog>

<style>
	dialog::backdrop { background: rgb(15 23 42 / 0.6); }
	.action { border-radius: .25rem; text-decoration: underline; text-underline-offset: .2em; padding: .25rem; }
	.action:focus-visible, .field:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
	.action:disabled { opacity: .5; }
	.field { display: block; width: 100%; min-width: 0; border: 1px solid #94a3b8; border-radius: .375rem; padding: .5rem; background: white; }
</style>
