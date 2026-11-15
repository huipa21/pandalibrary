<script lang="ts">
	import type { WordbookEntry } from './api.js';
	import * as m from '#lib/paraglide/messages.js';
	import { Volume2 } from '@lucide/svelte';
	import { entryPreview } from './preview.js';
	import EntryDetail from './EntryDetail.svelte';

	let { entry, disabled = false, readonly = false, language = '', meaningLanguage = '', meaningLanguages, onsave, ondelete }: {
		entry: WordbookEntry;
		disabled?: boolean;
		readonly?: boolean;
		showSources?: boolean;
		language?: string;
		meaningLanguage?: string;
		meaningLanguages?: string[];
		onsave: (id: number, changes: { text: string; definition?: string; note?: string }) => Promise<boolean>;
		ondelete: (id: number) => Promise<void>;
	} = $props();
	let open = $state(false);
	let speechError = $state('');
	const preview = $derived(entryPreview(entry, language, meaningLanguages ?? meaningLanguage));

	function pronounce() {
		speechError = '';
		if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
			speechError = m['wordbooks.pronunciationUnavailable']();
			return;
		}
		try {
			const utterance = new SpeechSynthesisUtterance(entry.text);
			if (preview.speechLanguage) utterance.lang = preview.speechLanguage;
			utterance.onerror = (event) => {
				if (event.error !== 'canceled' && event.error !== 'interrupted') speechError = m['wordbooks.pronunciationError']();
			};
			speechSynthesis.cancel();
			speechSynthesis.speak(utterance);
		} catch {
			speechError = m['wordbooks.pronunciationError']();
		}
	}
</script>

<article class="relative min-w-0" data-entry-preview>
	<button type="button" class="entry w-full rounded text-left" aria-label={entry.text} onclick={() => open = true}>
		<p class="preview-text text-lg font-medium" data-entry-text>{preview.text}</p>
		<p class="preview-metadata text-sm text-slate-600" class:has-speaker={!preview.reading} data-entry-metadata>{preview.metadata}</p>
		<p class="preview-meaning text-sm" data-entry-meaning>{preview.meaning}</p>
	</button>
	{#if !preview.reading}
		<button type="button" class="speaker rounded text-slate-600" aria-label={m['wordbooks.pronounce']()} onclick={pronounce}><Volume2 size={16} /></button>
	{/if}
	{#if speechError}
		<p role="status" class="fixed bottom-4 left-1/2 z-50 max-w-sm -translate-x-1/2 rounded bg-white p-3 text-sm text-red-700 shadow-lg">{speechError}</p>
	{/if}
	{#if open}
		<EntryDetail {entry} {language} {meaningLanguage} {meaningLanguages} {disabled} {readonly} {onsave} {ondelete} onclose={() => open = false} />
	{/if}
</article>

<style>
	.entry { display: block; height: 6rem; }
	.preview-text, .preview-metadata { height: 1.5rem; line-height: 1.5rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
	.has-speaker { padding-right: 1.75rem; }
	.preview-meaning { height: 3rem; line-height: 1.5rem; overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; white-space: pre-wrap; }
	.speaker { position: absolute; top: 1.5rem; right: 0; height: 1.5rem; width: 1.5rem; display: grid; place-items: center; }
	.entry:focus-visible, .speaker:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
</style>
