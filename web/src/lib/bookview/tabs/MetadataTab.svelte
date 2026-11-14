<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { getBookContext } from '../book-context.svelte.js';
	import MetadataEditView from '../metadata/MetadataEditView.svelte';
	import MetadataSearchView from '../metadata/MetadataSearchView.svelte';
	import { MetadataEditorState } from '../metadata/editor-state.svelte.js';

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

	beforeNavigate((navigation) => {
		if (!editor.dirty || editor.saving) return;
		if (navigation.to && navigation.to.url.pathname === page.url.pathname) return;
		if (navigation.type === 'leave') {
			navigation.cancel();
			return;
		}
		if (!confirm(m['metadata.unsaved_confirm']())) navigation.cancel();
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
</script>

<section class="metadata-tab" aria-labelledby="metadata-tab-heading">
	<h2 id="metadata-tab-heading" class="sr-only">{m['bv4.tabs.metadata']()}</h2>
	{#if !context.metadataAccessKnown}
		<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
	{:else if context.offline}
		<p class="notice" role="status">{m['metadata.tab.offline']()}</p>
	{:else if !context.canEditMetadata || editor.forbidden}
		<p class="rounded-md border border-amber-200 bg-amber-50 p-4 text-amber-900" role="alert">{m['metadata.edit.forbidden']()}</p>
		<a class="underline underline-offset-4 focus-visible:outline-2" href={`/books/${book.id}`}>{m['metadata.edit.back']()}</a>
	{:else if editor.error}
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">{editor.error}</p>
	{:else}
		<div class="toolbar">
			<nav class="view-switch" aria-label={m['metadata.view.label']()}>
				<a href={viewHref('edit')} aria-current={view === 'edit' ? 'page' : undefined}
					onclick={(event) => { event.preventDefault(); openView('edit'); }}>{m['metadata.view.edit']()}</a>
				<a href={viewHref('search')} aria-current={view === 'search' ? 'page' : undefined}
					onclick={(event) => { event.preventDefault(); openView('search'); }}>{m['metadata.view.search']()}</a>
			</nav>
			<div aria-live="polite" role="status" class="text-sm">
				{#if editor.notice}<p class="rounded-md bg-green-50 px-3 py-2 text-green-800">{editor.notice}</p>{/if}
			</div>
		</div>
		{#if view === 'search'}
			<MetadataSearchView {editor} coverSource={context.coverSource} />
		{:else}
			<MetadataEditView {editor} coverSource={context.coverSource} onSearch={() => openView('search')} />
		{/if}
	{/if}
</section>

<style>
	.metadata-tab { display: grid; gap: 1rem; min-width: 0; }
	.toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
	.view-switch { display: inline-flex; border: 1px solid #cbd5e1; border-radius: 0.5rem; padding: 0.125rem; background: #f8fafc; }
	.view-switch a { border-radius: 0.375rem; padding: 0.375rem 1rem; font-size: 0.875rem; font-weight: 500; color: #475569; }
	.view-switch a[aria-current='page'] { background: white; color: #0f172a; box-shadow: 0 1px 2px rgb(15 23 42 / 0.12); }
	.view-switch a:focus-visible { outline: 2px solid #334155; outline-offset: 2px; }
	.notice { border-radius: 0.375rem; background: #f1f5f9; padding: 1rem; color: #334155; }
</style>
