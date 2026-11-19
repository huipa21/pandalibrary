<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { confirmAction } from '#lib/shell/confirmation.js';
	import { onDestroy, untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { getBookContext } from '../book-context.svelte.js';
	import MetadataEditView from '../metadata/MetadataEditView.svelte';
	import MetadataSearchView from '../metadata/MetadataSearchView.svelte';
	import { MetadataEditorState } from '../metadata/editor-state.svelte.js';
	import Icon from '../Icon.svelte';

	type View = 'edit' | 'search';

	const context = getBookContext();
	const view = $derived<View>(page.url.searchParams.get('view') === 'search' ? 'search' : 'edit');
	const book = context.book!;
	const editor = new MetadataEditorState(book, (updated) => { context.book = updated; });

	$effect(() => {
		const current = context.book;
		if (current) untrack(() => editor.adopt(current));
	});

	$effect(() => {
		const ref = editor.candidate;
		const requestKey = editor.lookup?.request_key;
		untrack(() => { void editor.loadCover(ref?.cover_url ? ref : undefined, requestKey, false); });
	});

	$effect(() => {
		const ref = editor.selections.cover;
		const requestKey = editor.lookup?.request_key;
		untrack(() => { void editor.loadCover(ref, requestKey, true); });
	});

	let leaving = false;
	beforeNavigate((navigation) => {
		if (!editor.dirty || editor.saving || leaving || navigation.type === 'leave') return;
		if (navigation.to && navigation.to.url.pathname === page.url.pathname) return;
		navigation.cancel();
		void confirmAction(m['metadata.unsaved_confirm']()).then(async (accepted) => {
			if (!accepted || !navigation.to) return;
			leaving = true;
			try { await goto(navigation.to.url); }
			finally { leaving = false; }
		}).catch((error) => console.error('Could not leave the metadata editor', error));
	});

	onDestroy(() => editor.destroy());

	function viewHref(next: View): string {
		const url = new URL(page.url.href);
		if (next === 'search') url.searchParams.set('view', 'search');
		else url.searchParams.delete('view');
		return `${url.pathname}${url.search}${url.hash}`;
	}

	function openView(next: View) {
		void goto(viewHref(next), { replace: true, reset: false });
	}

	async function saveSearch() {
		if (await editor.save()) openView('edit');
	}
</script>

<section class="metadata-tab" aria-labelledby="metadata-tab-heading">
	<h2 id="metadata-tab-heading" class="sr-only">{m['bv4.tabs.metadata']()}</h2>
	{#if !context.metadataAccessKnown}
		<p use:showLoadingAfterDelay class="text-slate-600" role="status">{m['catalog.loading']()}</p>
	{:else if context.offline}
		<p class="notice" role="status">{m['metadata.tab.offline']()}</p>
	{:else if !context.canEditMetadata || editor.forbidden}
		<p class="rounded-md border border-amber-200 bg-amber-50 p-4 text-amber-900" role="alert">{m['metadata.edit.forbidden']()}</p>
		<a class="underline underline-offset-4 focus-visible:outline-2" href={`/books/${book.id}`}>{m['metadata.edit.back']()}</a>
	{:else if editor.error}
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">{editor.error}</p>
	{:else}
		<div aria-live="polite" role="status" class="text-sm">
			{#if editor.notice}<p class="rounded-md bg-green-50 px-3 py-2 text-green-800">{editor.notice}</p>{/if}
		</div>
		{#if view === 'search'}
			<button type="button" class="back-button" disabled={editor.busy}
				onclick={() => openView('edit')}><Icon name="arrow-left" />{m['bv4.tabs.metadata']()}</button>
			<MetadataSearchView {editor} coverSource={context.coverSource} onSave={saveSearch} />
		{:else}
			<MetadataEditView {editor} coverSource={context.coverSource} onSearch={() => openView('search')} />
		{/if}
	{/if}
</section>

<style>
	.metadata-tab { display: grid; gap: 1rem; min-width: 0; }
	.back-button { display: inline-flex; align-items: center; gap: 0.375rem; justify-self: start; border: 1px solid #cbd5e1; border-radius: 0.375rem; padding: 0.375rem 0.75rem; font-size: 0.875rem; }
	.back-button:focus-visible { outline: 2px solid #334155; outline-offset: 2px; }
	.back-button:disabled { opacity: 0.5; cursor: not-allowed; }
	.notice { border-radius: 0.375rem; background: #f1f5f9; padding: 1rem; color: #334155; }
</style>
