<script lang="ts">
	import { onMount } from 'svelte';
	import { v7 as uuidv7 } from 'uuid';
	import * as m from '#lib/paraglide/messages.js';
	import { annotationForReader, highlightColor, HIGHLIGHT_COLORS, type HighlightColor } from '#lib/reader/annotations.js';
	import { bookmarkForPosition } from '#lib/reader/bookmarks.js';
	import { renderMarkdown } from '#lib/reader/markdown.js';
	import NoteEditor from '#lib/reader/NoteEditor.svelte';
	import type { Bookmark, Note } from '#lib/reader/types.js';
	import type { ReaderController, NoteDraft, BookmarkDraft } from '#lib/reader/session/reader-controller.svelte.js';
	let { controller }: { controller: ReaderController } = $props();
	let surface = $state<HTMLDivElement>();
	let draft = $state<NoteDraft | null>(null);
	let bookmarkDraft = $state<BookmarkDraft | null>(null);
	let selectedColor = $state<HighlightColor>('yellow');
	let showBookmarks = $state(false);
	const progressPercent = $derived(Math.round((controller.location?.fraction ?? 0) * 100));
	$effect(() => {
		if (draft?.highlightId && !controller.highlights.some((highlight) => highlight.id === draft?.highlightId)) draft = null;
		if (draft?.editing && !controller.notes.some((note) => note.id === draft?.id)) draft = null;
		if (bookmarkDraft?.editing && !controller.bookmarks.some((bookmark) => bookmark.id === bookmarkDraft?.id)) bookmarkDraft = null;
	});
	onMount(() => {
		if (!surface) throw new Error('The reader surface is unavailable.');
		controller.setDraftGuard(() => {
			if (draft && draft.body !== draft.original && !window.confirm(m['reader.note.discard_confirm']())) return false;
			if (bookmarkDraft && bookmarkDraft.label !== bookmarkDraft.original && !window.confirm(m['ux6.discard_confirm']())) return false;
			return true;
		});
		void controller.attach(surface).catch((error) => console.error('Could not open the legacy reader view', error));
		return () => controller.setDraftGuard(() => true);
	});
	function openNote(highlightId: string | null, note?: Note) {
		if (draft && draft.body !== draft.original && !window.confirm(m['reader.note.discard_confirm']())) return;
		draft = { id: note?.id ?? uuidv7(), highlightId, body: note?.body_md ?? '', original: note?.body_md ?? '', editing: !!note };
	}
	function cancelNote() {
		if (draft && draft.body !== draft.original && !window.confirm(m['reader.note.discard_confirm']())) return;
		draft = null;
	}
	async function saveNote() {
		if (draft && await controller.saveNote(draft)) draft = null;
	}
	function editBookmark(bookmark: Bookmark) {
		bookmarkDraft = { id: bookmark.id, label: bookmark.label, original: bookmark.label, editing: true };
	}
	async function saveBookmark() {
		if (!bookmarkDraft) return;
		const existing = controller.bookmarks.find((bookmark) => bookmark.id === bookmarkDraft?.id);
		const saved = existing
			? await controller.updateBookmark(existing, bookmarkDraft)
			: await controller.addBookmark(bookmarkDraft);
		if (saved) bookmarkDraft = null;
	}
	function colorLabel(color: HighlightColor): string {
		switch (color) {
			case 'yellow': return m['reader.annotations.yellow']();
			case 'green': return m['reader.annotations.green']();
			case 'blue': return m['reader.annotations.blue']();
			case 'pink': return m['reader.annotations.pink']();
			case 'orange': return m['reader.annotations.orange']();
			case 'purple': return m['reader.annotations.purple']();
		}
	}
</script>

{#if controller.book && controller.file && controller.format}
	<article class="space-y-6">
		<header class="flex flex-wrap items-start justify-between gap-4">
			<div class="min-w-0 space-y-2">
				<a class="text-sm text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2" href={`/books/${controller.book.id}`}>{m['reader.back']()}</a>
				<h1 class="break-words text-2xl font-semibold tracking-tight">{controller.book.title}</h1>
				<p class="text-sm text-slate-600">{controller.file.format.toUpperCase()}</p>
			</div>
			<button class="rounded-md border border-slate-300 bg-white px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2" disabled={controller.closing} onclick={() => controller.close()}>
				{controller.closing ? m['reader.closing']() : m['reader.close']()}
			</button>
		</header>

		{#if controller.pendingError}
			<div role="alert" class="space-y-2 rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
				<p>{controller.pendingError}</p>
				<button class="underline focus-visible:outline-2" onclick={controller.retryWrites}>{m['reader.retry_saves']()}</button>
				<a class="ml-4 underline focus-visible:outline-2" href={`/books/${controller.book.id}`}>{m['reader.leave_unsaved']()}</a>
			</div>
		{/if}
		{#if controller.actionError}<p role="alert" class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{controller.actionError}</p>{/if}
		{#if controller.savedMessage}<p role="status" class="text-sm text-green-700">{controller.savedMessage}</p>{/if}
		{#if controller.opening}<p role="status" class="text-slate-600">{m['reader.loading']()}</p>{/if}

		<section aria-label={m['reader.surface']()} class="space-y-3">
			<!-- svelte-ignore a11y_no_noninteractive_tabindex: the book surface must be keyboard-scrollable -->
			<div bind:this={surface} role="region" aria-label={m['reader.surface']()} tabindex="0" class="h-[65vh] min-h-[24rem] overflow-hidden rounded-md border border-slate-300 bg-white focus-visible:outline-2 focus-visible:outline-offset-2"></div>
			<div class="flex flex-wrap items-center gap-3">
				<button class="rounded-md border border-slate-300 bg-white px-3 py-2 focus-visible:outline-2" disabled={!controller.ready} onclick={() => controller.turnPage('previous')}>{m['reader.previous']()}</button>
				<label for="reader-position" class="text-sm font-medium">{m['reader.position']()}</label>
				<input id="reader-position" class="min-w-28 flex-1 accent-slate-900 focus-visible:outline-2" type="range" min="0" max="1000" value={Math.round((controller.location?.fraction ?? 0) * 1000)} aria-valuetext={`${progressPercent}%`} disabled={!controller.ready} onchange={(event) => controller.goToFraction(Number(event.currentTarget.value) / 1000)} />
				<output for="reader-position" class="text-sm tabular-nums">{progressPercent}%</output>
				<button class="rounded-md border border-slate-300 bg-white px-3 py-2 focus-visible:outline-2" disabled={!controller.ready} onclick={() => controller.turnPage('next')}>{m['reader.next']()}</button>
			</div>
			<p class="text-sm text-slate-600">{m['reader.keyboard_hint']()}</p>
		</section>

		<details class="rounded-md border border-slate-200 bg-white p-4">
			<summary class="cursor-pointer text-lg font-semibold focus-visible:outline-2">{m['reader.settings.title']()}</summary>
			<div class="mt-4 space-y-4">
				<p class="text-sm text-slate-600">{m['reader.settings.scope']()}</p>
				{#if controller.settingsWarning}<p role="alert" class="text-sm text-amber-800">{controller.settingsWarning}</p>{/if}
				<div class="grid gap-4 sm:grid-cols-2">
					{#if controller.format !== 'pdf' && controller.format !== 'cbz'}
						<label class="space-y-1 text-sm font-medium">
							<span>{m['reader.settings.font']()}</span>
							<select class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2" bind:value={controller.settings.font} onchange={() => controller.applySettings()} disabled={!controller.ready}>
								<option value="serif">{m['reader.settings.serif']()}</option>
								<option value="sans-serif">{m['reader.settings.sans']()}</option>
								<option value="system">{m['reader.settings.system']()}</option>
							</select>
						</label>
						<label class="space-y-1 text-sm font-medium">
							<span>{m['reader.settings.spacing']()}: {controller.settings.spacing}</span>
							<input class="block w-full accent-slate-900 focus-visible:outline-2" type="range" min="1" max="2.5" step="0.1" bind:value={controller.settings.spacing} oninput={() => controller.applySettings()} disabled={!controller.ready} />
						</label>
						<label class="space-y-1 text-sm font-medium">
							<span>{m['reader.settings.flow']()}</span>
							<select class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2" bind:value={controller.settings.flow} onchange={() => controller.applySettings()} disabled={!controller.ready}>
								<option value="paginated">{m['reader.settings.paginated']()}</option>
								<option value="scrolled">{m['reader.settings.scrolled']()}</option>
							</select>
						</label>
					{/if}
					<label class="space-y-1 text-sm font-medium">
						<span>{m['reader.settings.size']()}: {controller.settings.size}%</span>
						<input class="block w-full accent-slate-900 focus-visible:outline-2" type="range" min="50" max="200" step="5" bind:value={controller.settings.size} oninput={() => controller.applySettings()} disabled={!controller.ready} />
					</label>
					{#if controller.format !== 'cbz'}
						<label class="space-y-1 text-sm font-medium">
							<span>{m['reader.settings.theme']()}</span>
							<select class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2" bind:value={controller.settings.theme} onchange={() => controller.applySettings()} disabled={!controller.ready}>
								<option value="light">{m['reader.settings.light']()}</option>
								<option value="sepia">{m['reader.settings.sepia']()}</option>
								<option value="dark">{m['reader.settings.dark']()}</option>
							</select>
						</label>
					{/if}
				</div>
				<button class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={!controller.ready || controller.busy || !controller.canSaveSettings} onclick={() => controller.saveSettings()}>{m['reader.settings.save']()}</button>
			</div>
		</details>

		<section aria-labelledby="annotations-heading" class="space-y-4">
			<h2 id="annotations-heading" class="text-xl font-semibold">{m['reader.annotations.title']()}</h2>
			<p class="text-sm text-slate-600">{m['reader.annotations.description']()}</p>
			{#if controller.selection}
				<div class="rounded-md border-l-4 border-yellow-400 bg-yellow-50 p-3 text-sm">
					<p class="font-medium">{m['reader.annotations.selected']()}</p>
					<p class="mt-1 whitespace-pre-wrap break-words">{controller.selection.text}</p>
				</div>
			{/if}
			<div class="flex flex-wrap items-end gap-3">
				<label class="space-y-1 text-sm font-medium">
					<span>{m['reader.annotations.color']()}</span>
					<select class="block rounded-md border border-slate-300 bg-white p-2 focus-visible:outline-2" bind:value={selectedColor}>
						{#each HIGHLIGHT_COLORS as color}<option value={color}>{colorLabel(color)}</option>{/each}
					</select>
				</label>
				<button class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={!controller.ready || controller.busy || (!controller.selection && controller.format !== 'cbz')} onclick={() => controller.addHighlight(controller.selection, selectedColor)}>
					{controller.format === 'cbz' && !controller.selection ? m['reader.annotations.add_page']() : m['reader.annotations.add_highlight']()}
				</button>
				<button class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium focus-visible:outline-2" disabled={!controller.ready || controller.busy} onclick={() => openNote(null)}>{m['reader.annotations.add_note']()}</button>
			</div>

			{#if draft}
				<form class="space-y-4 rounded-md border border-slate-300 bg-slate-50 p-4" onsubmit={(event) => { event.preventDefault(); void saveNote(); }}>
					<h3 class="font-semibold">{draft.editing ? m['reader.note.edit']() : m['reader.note.new']()}</h3>
					{#key draft.id}
						<NoteEditor value={draft.body} onChange={(value) => { if (draft) draft.body = value; }} />
					{/key}
					<div class="flex flex-wrap gap-3">
						<button class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={controller.busy || !draft.body.trim()}>{m['reader.note.save']()}</button>
						<button type="button" class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2" onclick={cancelNote}>{m['reader.note.cancel']()}</button>
					</div>
				</form>
			{/if}

			{#if !controller.highlights.length && !controller.notes.length}
				<p class="text-slate-600">{m['reader.annotations.empty']()}</p>
			{/if}
			{#if controller.bookNotes.length}
				<div class="space-y-3">
					<h3 class="font-semibold">{m['reader.annotations.book_notes']()}</h3>
					{#each controller.bookNotes as note (note.id)}
						<div class="space-y-3 rounded-md border border-slate-200 bg-white p-4">
							<div class="reader-markdown break-words text-sm">{@html renderMarkdown(note.body_md)}</div>
							<div class="flex gap-4 text-sm">
								<button class="underline focus-visible:outline-2" onclick={() => openNote(null, note)}>{m['reader.annotations.edit']()}</button>
								<button class="underline focus-visible:outline-2" disabled={controller.busy} onclick={() => controller.deleteNote(note)}>{m['reader.annotations.delete']()}</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
			{#each controller.orderedHighlights as highlight (highlight.id)}
				<div class="space-y-3 rounded-md border border-slate-200 bg-white p-4">
					<blockquote class="whitespace-pre-wrap break-words border-l-4 border-yellow-400 pl-3">{highlight.text || m['reader.annotations.page_highlight']()}</blockquote>
					<div class="flex flex-wrap items-end gap-3 text-sm">
						{#if annotationForReader(highlight, controller.file.id, controller.format)}
							<button class="underline focus-visible:outline-2" onclick={() => controller.goToHighlight(highlight)}>{m['reader.annotations.go_to']()}</button>
						{:else}
							<span class="text-slate-600">{m['reader.annotations.other_file']()}</span>
						{/if}
						<label class="space-y-1">
							<span>{m['reader.annotations.color']()}</span>
							<select class="block rounded-md border border-slate-300 p-1 focus-visible:outline-2" value={highlightColor(highlight.color)} disabled={controller.busy} onchange={(event) => controller.updateHighlight(highlight, { color: event.currentTarget.value })}>
								{#each HIGHLIGHT_COLORS as color}<option value={color}>{colorLabel(color)}</option>{/each}
							</select>
						</label>
						<button class="underline focus-visible:outline-2" disabled={controller.busy} onclick={() => openNote(highlight.id)}>{m['reader.annotations.attach_note']()}</button>
						<button class="underline focus-visible:outline-2" disabled={controller.busy} onclick={() => controller.removeHighlight(highlight)}>{m['reader.annotations.delete']()}</button>
					</div>
					{#each controller.notes.filter((note) => note.highlight_id === highlight.id) as note (note.id)}
						<div class="space-y-2 rounded-md bg-slate-50 p-3">
							<div class="reader-markdown break-words text-sm">{@html renderMarkdown(note.body_md)}</div>
							<div class="flex gap-4 text-sm">
								<button class="underline focus-visible:outline-2" onclick={() => openNote(highlight.id, note)}>{m['reader.annotations.edit']()}</button>
								<button class="underline focus-visible:outline-2" disabled={controller.busy} onclick={() => controller.deleteNote(note)}>{m['reader.annotations.delete']()}</button>
							</div>
						</div>
					{/each}
				</div>
			{/each}
		</section>

		<section aria-labelledby="bookmarks-heading" class="space-y-4">
			<div class="flex items-center justify-between">
				<h2 id="bookmarks-heading" class="text-xl font-semibold">{m['ux6.title']()}</h2>
				<button class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium focus-visible:outline-2" aria-expanded={showBookmarks} disabled={!controller.ready || controller.busy} onclick={() => showBookmarks = !showBookmarks}>
					{showBookmarks ? m['ux6.hide']() : m['ux6.show']()} ({controller.bookmarks.length})
				</button>
			</div>
			<div class="flex flex-wrap gap-3">
				<button class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={!controller.ready || controller.busy} onclick={() => bookmarkDraft = { id: uuidv7(), label: '', original: '', editing: false }}>{m['ux6.save_position']()}</button>
				{#if controller.availableBookmarks.length > 0}
					<select aria-label={m['ux6.jump']()} class="rounded-md border border-slate-300 p-2 focus-visible:outline-2" disabled={!controller.ready || controller.busy} onchange={(event) => {
						const bm = controller.availableBookmarks.find((b) => b.id === event.currentTarget.value);
						if (bm) void controller.jumpToBookmark(bm);
						event.currentTarget.value = '';
					}}>
						<option value="">{m['ux6.jump']()}</option>
						{#each controller.availableBookmarks as bookmark (bookmark.id)}
							<option value={bookmark.id}>{bookmark.label || m['ux6.unnamed']()}</option>
						{/each}
					</select>
				{/if}
			</div>

			{#if bookmarkDraft}
				<form class="space-y-3 rounded-md border border-slate-300 bg-slate-50 p-4" onsubmit={(event) => { event.preventDefault(); void saveBookmark(); }}>
					<h3 class="font-semibold">{bookmarkDraft.editing ? m['ux6.edit_title']() : m['ux6.new_title']()}</h3>
					<label class="space-y-1 text-sm font-medium">
						<span>{m['ux6.label']()}</span>
						<input
							type="text"
							class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2"
							bind:value={bookmarkDraft.label}
							maxlength="512"
							disabled={controller.busy}
						/>
					</label>
					<div class="flex flex-wrap gap-3">
						<button type="submit" class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={controller.busy}>{m['ux6.save']()}</button>
						<button type="button" class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2" disabled={controller.busy} onclick={() => { bookmarkDraft = null; }}>{m['ux6.cancel']()}</button>
					</div>
				</form>
			{/if}

			{#if !controller.bookmarks.length}
				<p class="text-slate-600">{m['ux6.empty']()}</p>
			{:else if showBookmarks}
				<div class="space-y-3">
					{#each controller.bookmarks as bookmark (bookmark.id)}
						<div class="space-y-2 rounded-md border border-slate-200 bg-white p-4">
							<div class="flex items-start justify-between">
								<div class="min-w-0 flex-1">
									<p class="font-semibold">{bookmark.label || m['ux6.unnamed']()}</p>
									<p class="text-sm text-slate-600">{(Math.round(bookmark.position * 1000) / 10).toFixed(1)}%{bookmark.chapter ? ` — ${bookmark.chapter}` : ''}</p>
									{#if !bookmarkForPosition(bookmark, controller.file.id, controller.format)}
										<p class="text-sm text-amber-800">{m['ux6.unavailable']()}</p>
									{/if}
								</div>
								<time class="whitespace-nowrap text-sm text-slate-600">{new Date(bookmark.created_at).toLocaleDateString()}</time>
							</div>
							<div class="flex flex-wrap gap-3 text-sm">
								<button class="underline focus-visible:outline-2" disabled={controller.busy || !bookmarkForPosition(bookmark, controller.file.id, controller.format)} onclick={() => void controller.jumpToBookmark(bookmark)}>{m['ux6.jump']()}</button>
								<button class="underline focus-visible:outline-2" disabled={controller.busy || bookmark.book_file_id === null} onclick={() => editBookmark(bookmark)}>{m['ux6.edit']()}</button>
								<button class="underline focus-visible:outline-2" disabled={controller.busy} onclick={() => void controller.removeBookmark(bookmark)}>{m['ux6.delete']()}</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	</article>
{/if}
<style>
	.reader-markdown :global(p),
	.reader-markdown :global(ul),
	.reader-markdown :global(ol),
	.reader-markdown :global(pre) {
		margin-block: 0.5rem;
	}

	.reader-markdown :global(a) {
		color: #1d4ed8;
		text-decoration: underline;
	}
</style>
